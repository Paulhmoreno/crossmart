import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { describeError } from '@crossmart/common';
import {
  AiConfigStatus,
  type Prisma,
  PrismaService,
  type WorkspaceAiConfig,
} from '@crossmart/database';
import type { Actor } from '../../activity/entities/actor.js';
import { ActivityAction } from '../../activity/enums/activity-action.enum.js';
import { ActivitySubjectType } from '../../activity/enums/activity-subject-type.enum.js';
import { ActivityRecorder } from '../../activity/services/activity-recorder.js';
import {
  type AiCapabilities,
  AiConfigSource,
  ANTHROPIC_DEFAULT_CAPABILITIES,
  type ListAiModelsInput,
  type ListAiModelsResult,
  type SaveAiConfigInput,
  type TestAiConfigInput,
  type TestAiConfigResult,
  UNKNOWN_AI_CAPABILITIES,
  type WorkspaceAiConfigView,
} from '../entities/ai-config.js';
import { AiProviderName } from '../enums/ai-provider-name.enum.js';
import { AiKeyRejectedError, AiNotConfiguredError } from '../errors/ai.errors.js';
import { AiProvider } from '../providers/ai-provider.js';
import { AnthropicAiProvider } from '../providers/anthropic/anthropic-ai.provider.js';
import { AnthropicClientFactory } from '../providers/anthropic/anthropic-client.factory.js';
import { OpenAiCompatibleAiProvider } from '../providers/openai-compatible/openai-compatible-ai.provider.js';
import { normalizeOpenAiBaseUrl } from '../providers/openai-compatible/openai-compatible-url.js';
import { AiCredentialsVault } from './ai-credentials.vault.js';

const MODEL_REQUIRED = 'Ingresa el identificador del modelo.';
const API_KEY_REQUIRED = 'Ingresa una API Key para este proveedor.';
const BASE_URL_REQUIRED = 'Ingresa la URL base de la API OpenAI Compatible.';
const MAX_STORED_ERROR_LENGTH = 400;

export interface ResolvedWorkspaceAiProvider {
  provider: AiProvider;
  source: AiConfigSource;
  configured: boolean;
  capabilities: AiCapabilities;
  /** True when the workspace explicitly chose a model that must override server defaults. */
  forceModel: boolean;
}

function parseCapabilities(raw: Prisma.JsonValue | null | undefined): AiCapabilities {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...UNKNOWN_AI_CAPABILITIES };
  }
  const obj = raw as Record<string, unknown>;
  return {
    structuredOutput: Boolean(obj.structuredOutput),
    jsonSchema: Boolean(obj.jsonSchema),
    streaming: Boolean(obj.streaming),
    toolCalling: Boolean(obj.toolCalling),
    vision: Boolean(obj.vision),
    modelsEndpoint: Boolean(obj.modelsEndpoint),
  };
}

function parseProviderName(raw: string): AiProviderName {
  return raw === AiProviderName.OpenAiCompatible
    ? AiProviderName.OpenAiCompatible
    : AiProviderName.Anthropic;
}

function providerLabel(provider: AiProviderName): string {
  return provider === AiProviderName.OpenAiCompatible ? 'OpenAI Compatible' : 'Anthropic';
}

function truncateError(error: unknown): string {
  return describeError(error).slice(0, MAX_STORED_ERROR_LENGTH);
}

/**
 * Manages encrypted per-workspace AI provider configuration (Anthropic or OpenAI-compatible)
 * and resolves the live `AiProvider` for API, Worker, and Agent Console without recompiling.
 */
@Injectable()
export class AiConfigService {
  private readonly logger = new Logger(AiConfigService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly vault: AiCredentialsVault,
    private readonly anthropicClients: AnthropicClientFactory,
    private readonly defaultProvider: AiProvider,
    private readonly activity: ActivityRecorder,
  ) {}

  async getConfig(workspaceId: string): Promise<WorkspaceAiConfigView> {
    const record = await this.prisma.workspaceAiConfig.findUnique({ where: { workspaceId } });
    if (record) return this.toView(record);

    const envConfigured = this.defaultProvider.isConfigured();
    return {
      configured: envConfigured,
      source: envConfigured ? AiConfigSource.Environment : AiConfigSource.None,
      provider: this.defaultProvider.name,
      baseUrl: null,
      model: this.defaultProvider.model,
      hasApiKey: envConfigured,
      status: envConfigured ? AiConfigStatus.CONNECTED : AiConfigStatus.DISABLED,
      capabilities: envConfigured
        ? { ...ANTHROPIC_DEFAULT_CAPABILITIES }
        : { ...UNKNOWN_AI_CAPABILITIES },
      lastError: null,
      lastTestedAt: null,
      updatedAt: null,
    };
  }

  async resolveForWorkspace(workspaceId: string): Promise<ResolvedWorkspaceAiProvider> {
    const record = await this.prisma.workspaceAiConfig.findUnique({ where: { workspaceId } });
    if (!record) {
      const configured = this.defaultProvider.isConfigured();
      return {
        provider: this.defaultProvider,
        source: configured ? AiConfigSource.Environment : AiConfigSource.None,
        configured,
        capabilities: configured
          ? { ...ANTHROPIC_DEFAULT_CAPABILITIES }
          : { ...UNKNOWN_AI_CAPABILITIES },
        forceModel: false,
      };
    }

    if (record.status === AiConfigStatus.DISABLED) {
      return {
        provider: this.defaultProvider,
        source: AiConfigSource.Workspace,
        configured: false,
        capabilities: parseCapabilities(record.capabilities),
        forceModel: true,
      };
    }

    const apiKey = record.sealedCredentials
      ? (await this.vault.open(workspaceId, record.sealedCredentials)).apiKey
      : null;
    const providerName = parseProviderName(record.provider);
    const provider = this.instantiateProvider(providerName, record.baseUrl, apiKey, record.model);
    return {
      provider,
      source: AiConfigSource.Workspace,
      configured: provider.isConfigured(),
      capabilities: parseCapabilities(record.capabilities),
      forceModel: true,
    };
  }

  async testConfig(workspaceId: string, input: TestAiConfigInput): Promise<TestAiConfigResult> {
    const startedAt = performance.now();
    try {
      const existing = await this.prisma.workspaceAiConfig.findUnique({ where: { workspaceId } });
      const resolved = await this.resolveInputs(workspaceId, existing, input);
      const result = await this.probeProvider(
        resolved.provider,
        resolved.baseUrl,
        resolved.apiKey,
        resolved.model,
      );
      const latencyMs = Math.round(performance.now() - startedAt);
      await this.updateTestMetadata(workspaceId, existing, resolved, result.capabilities, null);
      return {
        ok: true,
        provider: resolved.provider,
        resolvedModel: result.resolvedModel,
        latencyMs,
        capabilities: result.capabilities,
        error: null,
      };
    } catch (error) {
      const latencyMs = Math.round(performance.now() - startedAt);
      const message = truncateError(error);
      await this.prisma.workspaceAiConfig.updateMany({
        where: { workspaceId },
        data: { lastTestedAt: new Date(), lastError: message },
      });
      return {
        ok: false,
        provider: input.provider,
        resolvedModel: null,
        latencyMs,
        capabilities: { ...UNKNOWN_AI_CAPABILITIES },
        error: message,
      };
    }
  }

  async listModels(workspaceId: string, input: ListAiModelsInput): Promise<ListAiModelsResult> {
    if (input.provider !== AiProviderName.OpenAiCompatible) {
      return {
        supported: false,
        models: [],
        error:
          'Anthropic no expone un listado estándar compatible aquí; ingresa el modelo manualmente.',
      };
    }
    try {
      const existing = await this.prisma.workspaceAiConfig.findUnique({ where: { workspaceId } });
      const rawBaseUrl = input.baseUrl?.trim() || existing?.baseUrl || '';
      if (!rawBaseUrl) throw new BadRequestException(BASE_URL_REQUIRED);
      const { baseUrl, isPrivate } = normalizeOpenAiBaseUrl(rawBaseUrl);
      const apiKey = await this.resolveApiKey(
        workspaceId,
        existing,
        input.provider,
        input.apiKey,
        isPrivate,
      );
      const provider = new OpenAiCompatibleAiProvider({ baseUrl, apiKey, model: 'probe' });
      const listed = await provider.listModels();
      return { supported: listed.supported, models: listed.models, error: null };
    } catch (error) {
      return { supported: false, models: [], error: truncateError(error) };
    }
  }

  async saveConfig(
    workspaceId: string,
    input: SaveAiConfigInput,
    actor: Actor,
  ): Promise<WorkspaceAiConfigView> {
    const existing = await this.prisma.workspaceAiConfig.findUnique({ where: { workspaceId } });
    const resolved = await this.resolveInputs(workspaceId, existing, input);
    const sealedCredentials = resolved.apiKey
      ? await this.vault.seal(workspaceId, { apiKey: resolved.apiKey })
      : null;

    const capabilities =
      existing &&
      existing.provider === resolved.provider &&
      existing.baseUrl === resolved.baseUrl &&
      existing.model === resolved.model
        ? parseCapabilities(existing.capabilities)
        : resolved.provider === AiProviderName.Anthropic
          ? { ...ANTHROPIC_DEFAULT_CAPABILITIES }
          : { ...UNKNOWN_AI_CAPABILITIES };

    const saved = await this.prisma.workspaceAiConfig.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
        provider: resolved.provider,
        baseUrl: resolved.baseUrl,
        model: resolved.model,
        sealedCredentials,
        status: AiConfigStatus.CONNECTED,
        capabilities: capabilities as unknown as Prisma.InputJsonValue,
        lastError: null,
        updatedById: actor.userId,
      },
      update: {
        provider: resolved.provider,
        baseUrl: resolved.baseUrl,
        model: resolved.model,
        sealedCredentials,
        status: AiConfigStatus.CONNECTED,
        capabilities: capabilities as unknown as Prisma.InputJsonValue,
        lastError: null,
        updatedById: actor.userId,
      },
    });

    await this.activity.record(workspaceId, actor, {
      action: ActivityAction.AiConfigUpdated,
      subject: {
        type: ActivitySubjectType.Workspace,
        id: workspaceId,
        label: providerLabel(resolved.provider),
      },
      detail: resolved.model,
    });
    return this.toView(saved);
  }

  async clearConfig(workspaceId: string, actor: Actor): Promise<WorkspaceAiConfigView> {
    await this.prisma.workspaceAiConfig.deleteMany({ where: { workspaceId } });
    await this.activity.record(workspaceId, actor, {
      action: ActivityAction.AiConfigCleared,
      subject: {
        type: ActivitySubjectType.Workspace,
        id: workspaceId,
        label: 'Inteligencia artificial',
      },
    });
    return this.getConfig(workspaceId);
  }

  async recordCallOutcome(workspaceId: string, error: unknown): Promise<void> {
    try {
      if (error === null) {
        await this.prisma.workspaceAiConfig.updateMany({
          where: { workspaceId, lastError: { not: null } },
          data: { status: AiConfigStatus.CONNECTED, lastError: null },
        });
        return;
      }
      if (error instanceof AiNotConfiguredError) return;
      const status =
        error instanceof AiKeyRejectedError ? AiConfigStatus.ERROR : AiConfigStatus.CONNECTED;
      await this.prisma.workspaceAiConfig.updateMany({
        where: { workspaceId },
        data: { status, lastError: truncateError(error) },
      });
    } catch {
      this.logger.debug('Could not persist AI call outcome on workspace config');
    }
  }

  private async resolveInputs(
    workspaceId: string,
    existing: WorkspaceAiConfig | null,
    input: {
      provider: AiProviderName;
      baseUrl?: string | null;
      apiKey?: string | null;
      model: string;
    },
  ): Promise<{
    provider: AiProviderName;
    baseUrl: string | null;
    apiKey: string | null;
    model: string;
  }> {
    const model = input.model.trim();
    if (!model) throw new BadRequestException(MODEL_REQUIRED);

    if (input.provider === AiProviderName.Anthropic) {
      const apiKey = await this.resolveApiKey(
        workspaceId,
        existing,
        input.provider,
        input.apiKey,
        false,
      );
      return { provider: AiProviderName.Anthropic, baseUrl: null, apiKey, model };
    }

    const rawBaseUrl = input.baseUrl?.trim() || '';
    if (!rawBaseUrl) throw new BadRequestException(BASE_URL_REQUIRED);
    const { baseUrl, isPrivate } = normalizeOpenAiBaseUrl(rawBaseUrl);
    const apiKey = await this.resolveApiKey(
      workspaceId,
      existing,
      input.provider,
      input.apiKey,
      isPrivate,
    );
    return { provider: AiProviderName.OpenAiCompatible, baseUrl, apiKey, model };
  }

  private async resolveApiKey(
    workspaceId: string,
    existing: WorkspaceAiConfig | null,
    provider: AiProviderName,
    suppliedKey: string | null | undefined,
    allowKeyless: boolean,
  ): Promise<string | null> {
    const trimmed = suppliedKey?.trim() ?? '';
    if (trimmed.length > 0) return trimmed;
    if (existing && existing.provider === provider && existing.sealedCredentials) {
      return (await this.vault.open(workspaceId, existing.sealedCredentials)).apiKey;
    }
    if (allowKeyless) return null;
    throw new BadRequestException(API_KEY_REQUIRED);
  }

  private instantiateProvider(
    provider: AiProviderName,
    baseUrl: string | null,
    apiKey: string | null,
    model: string,
  ): AiProvider {
    if (provider === AiProviderName.OpenAiCompatible) {
      if (!baseUrl) {
        throw new BadRequestException(BASE_URL_REQUIRED);
      }
      return new OpenAiCompatibleAiProvider({ baseUrl, apiKey, model });
    }
    if (!apiKey) {
      throw new AiNotConfiguredError();
    }
    return AnthropicAiProvider.fromCredentials(this.anthropicClients, apiKey, model);
  }

  private async probeProvider(
    provider: AiProviderName,
    baseUrl: string | null,
    apiKey: string | null,
    model: string,
  ): Promise<{ resolvedModel: string; capabilities: AiCapabilities }> {
    if (provider === AiProviderName.OpenAiCompatible) {
      const instance = new OpenAiCompatibleAiProvider({
        baseUrl: baseUrl ?? '',
        apiKey,
        model,
      });
      return instance.probeCapabilities();
    }
    if (!apiKey) throw new BadRequestException(API_KEY_REQUIRED);
    const instance = AnthropicAiProvider.fromCredentials(this.anthropicClients, apiKey, model);
    const completion = await instance.complete({
      system: 'Return JSON with ok=true.',
      prompt: 'ping',
      schema: z.object({ ok: z.boolean() }),
      maxOutputTokens: 64,
    });
    return {
      resolvedModel: completion.model,
      capabilities: { ...ANTHROPIC_DEFAULT_CAPABILITIES },
    };
  }

  private async updateTestMetadata(
    workspaceId: string,
    existing: WorkspaceAiConfig | null,
    resolved: { provider: AiProviderName; baseUrl: string | null; model: string },
    capabilities: AiCapabilities,
    lastError: string | null,
  ): Promise<void> {
    if (
      !existing ||
      existing.provider !== resolved.provider ||
      existing.baseUrl !== resolved.baseUrl ||
      existing.model !== resolved.model
    ) {
      return;
    }
    await this.prisma.workspaceAiConfig.update({
      where: { workspaceId },
      data: {
        status: lastError ? AiConfigStatus.ERROR : AiConfigStatus.CONNECTED,
        capabilities: capabilities as unknown as Prisma.InputJsonValue,
        lastError,
        lastTestedAt: new Date(),
      },
    });
  }

  private toView(record: WorkspaceAiConfig): WorkspaceAiConfigView {
    const provider = parseProviderName(record.provider);
    const hasApiKey = Boolean(record.sealedCredentials);
    const isPrivate =
      provider === AiProviderName.OpenAiCompatible &&
      Boolean(record.baseUrl) &&
      normalizeOpenAiBaseUrl(record.baseUrl!).isPrivate;
    const configured =
      record.status !== AiConfigStatus.DISABLED &&
      Boolean(record.model) &&
      (hasApiKey || isPrivate);
    return {
      configured,
      source: AiConfigSource.Workspace,
      provider,
      baseUrl: record.baseUrl,
      model: record.model,
      hasApiKey,
      status: record.status,
      capabilities: parseCapabilities(record.capabilities),
      lastError: record.lastError,
      lastTestedAt: record.lastTestedAt,
      updatedAt: record.updatedAt,
    };
  }
}
