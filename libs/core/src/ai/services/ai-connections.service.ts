import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { describeError } from '@crossmart/common';
import { type AiConnection, AiConfigStatus, type Prisma, PrismaService } from '@crossmart/database';
import type { Actor } from '../../activity/entities/actor.js';
import { ActivityAction } from '../../activity/enums/activity-action.enum.js';
import { ActivitySubjectType } from '../../activity/enums/activity-subject-type.enum.js';
import { ActivityRecorder } from '../../activity/services/activity-recorder.js';
import {
  type AiCapabilities,
  AiConfigSource,
  type AiModelOption,
  ANTHROPIC_DEFAULT_CAPABILITIES,
  type ListAiModelsResult,
  type TestAiConfigResult,
  UNKNOWN_AI_CAPABILITIES,
} from '../entities/ai-config.js';
import { AiProviderName } from '../enums/ai-provider-name.enum.js';
import { AiKeyRejectedError, AiNotConfiguredError } from '../errors/ai.errors.js';
import { AiProvider } from '../providers/ai-provider.js';
import { AnthropicAiProvider } from '../providers/anthropic/anthropic-ai.provider.js';
import { AnthropicClientFactory } from '../providers/anthropic/anthropic-client.factory.js';
import {
  GEMINI_OFFICIAL_BASE_URL,
  GeminiAiProvider,
} from '../providers/gemini/gemini-ai.provider.js';
import {
  AiDiagnosticError,
  OpenAiCompatibleAiProvider,
} from '../providers/openai-compatible/openai-compatible-ai.provider.js';
import { normalizeOpenAiBaseUrl } from '../providers/openai-compatible/openai-compatible-url.js';
import { AiCredentialsVault } from './ai-credentials.vault.js';

export const OPENAI_OFFICIAL_BASE_URL = 'https://api.openai.com/v1';
export const ANTHROPIC_OFFICIAL_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_API_VERSION = '2023-06-01';
const MAX_ERROR_LENGTH = 400;
const PROBE_MAX_TOKENS = 64;

const PROVIDER_VALUES = new Set<string>(Object.values(AiProviderName));

export interface AiConnectionView {
  id: string;
  name: string;
  provider: AiProviderName;
  baseUrl: string | null;
  defaultModel: string;
  availableModels: string[];
  hasApiKey: boolean;
  status: AiConfigStatus;
  isDefault: boolean;
  capabilities: AiCapabilities;
  usedByAgents: string[];
  lastError: string | null;
  lastTestedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SaveAiConnectionInput {
  name: string;
  provider: AiProviderName;
  baseUrl?: string | null;
  apiKey?: string | null;
  defaultModel: string;
  availableModels?: string[];
  isDefault?: boolean;
  enabled?: boolean;
}

export interface TestAiConnectionInput {
  connectionId?: string | null;
  provider: AiProviderName;
  baseUrl?: string | null;
  apiKey?: string | null;
  model: string;
}

export interface ListProviderModelsInput {
  connectionId?: string | null;
  provider: AiProviderName;
  baseUrl?: string | null;
  apiKey?: string | null;
}

export interface ResolvedAiCallProvider {
  provider: AiProvider;
  connectionId: string | null;
  source: AiConfigSource;
  configured: boolean;
  forceModel: boolean;
}

function parseProvider(raw: string): AiProviderName {
  return PROVIDER_VALUES.has(raw) ? (raw as AiProviderName) : AiProviderName.Anthropic;
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

function parseModelsList(raw: Prisma.JsonValue | null | undefined): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function truncateError(error: unknown): string {
  if (error instanceof AiDiagnosticError || error instanceof HttpException) {
    return error.message.slice(0, MAX_ERROR_LENGTH);
  }
  return describeError(error).slice(0, MAX_ERROR_LENGTH);
}

function requiresCustomBaseUrl(provider: AiProviderName): boolean {
  return (
    provider === AiProviderName.OpenAiCompatible || provider === AiProviderName.AnthropicCompatible
  );
}

function defaultLabelForProvider(provider: AiProviderName): string {
  switch (provider) {
    case AiProviderName.OpenAi:
      return 'OpenAI';
    case AiProviderName.Anthropic:
      return 'Claude (Anthropic)';
    case AiProviderName.Gemini:
      return 'Gemini (Google)';
    case AiProviderName.OpenAiCompatible:
      return 'OpenAI Compatible';
    case AiProviderName.AnthropicCompatible:
      return 'Claude Compatible';
  }
}

async function fetchAnthropicModels(
  baseUrl: string,
  apiKey: string,
): Promise<{ supported: boolean; models: AiModelOption[] }> {
  const cleanBase = baseUrl.replace(/\/+$/, '');
  const endpoint = cleanBase.endsWith('/v1') ? `${cleanBase}/models` : `${cleanBase}/v1/models`;
  const response = await fetch(endpoint, {
    method: 'GET',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_API_VERSION,
    },
  });
  if (!response.ok) return { supported: false, models: [] };
  const body = (await response.json()) as { data?: Array<{ id?: string }> };
  const models: AiModelOption[] = (body.data ?? [])
    .map((entry) => ({ id: entry.id?.trim() ?? '', ownedBy: 'anthropic' }))
    .filter((entry) => entry.id.length > 0);
  return { supported: true, models };
}

/**
 * Manages multiple encrypted AI provider connections per workspace across all 5 provider families,
 * automatically migrates legacy `WorkspaceAiConfig` rows without losing credentials or models,
 * prevents silent deletion/deactivation of connections used by agents, and resolves per-agent
 * providers dynamically without silent cross-provider fallbacks.
 */
@Injectable()
export class AiConnectionsService {
  private readonly logger = new Logger(AiConnectionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly vault: AiCredentialsVault,
    private readonly anthropicClients: AnthropicClientFactory,
    private readonly defaultProvider: AiProvider,
    private readonly activity: ActivityRecorder,
  ) {}

  /** Migrates a legacy single `WorkspaceAiConfig` row into `ai_connections` on first access. */
  async ensureLegacyMigrated(workspaceId: string): Promise<void> {
    const existingCount = await this.prisma.aiConnection.count({ where: { workspaceId } });
    if (existingCount > 0) return;
    const legacy = await this.prisma.workspaceAiConfig.findUnique({ where: { workspaceId } });
    if (!legacy) return;
    const provider = parseProvider(legacy.provider);
    await this.prisma.aiConnection.create({
      data: {
        workspaceId,
        name: defaultLabelForProvider(provider),
        provider,
        baseUrl: legacy.baseUrl,
        sealedCredentials: legacy.sealedCredentials,
        defaultModel: legacy.model,
        availableModels: [legacy.model] as unknown as Prisma.InputJsonValue,
        capabilities: legacy.capabilities as Prisma.InputJsonValue,
        status: legacy.status,
        isDefault: true,
        lastError: legacy.lastError,
        lastTestedAt: legacy.lastTestedAt,
        updatedById: legacy.updatedById,
      },
    });
  }

  async listConnections(workspaceId: string): Promise<AiConnectionView[]> {
    await this.ensureLegacyMigrated(workspaceId);
    const [connections, agentConfigs] = await Promise.all([
      this.prisma.aiConnection.findMany({
        where: { workspaceId },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      }),
      this.prisma.workspaceAgentConfig.findMany({
        where: { workspaceId },
        select: { agentKey: true, aiConnectionId: true },
      }),
    ]);
    const usageByConn = new Map<string, string[]>();
    for (const cfg of agentConfigs) {
      if (!cfg.aiConnectionId) continue;
      const list = usageByConn.get(cfg.aiConnectionId) ?? [];
      list.push(cfg.agentKey);
      usageByConn.set(cfg.aiConnectionId, list);
    }
    return connections.map((conn) => this.toView(conn, usageByConn.get(conn.id) ?? []));
  }

  async createConnection(
    workspaceId: string,
    input: SaveAiConnectionInput,
    actor: Actor,
  ): Promise<AiConnectionView> {
    await this.ensureLegacyMigrated(workspaceId);
    const resolved = await this.resolveInputs(workspaceId, null, input);
    const sealedCredentials = resolved.apiKey
      ? await this.vault.seal(workspaceId, { apiKey: resolved.apiKey })
      : null;
    const existingCount = await this.prisma.aiConnection.count({ where: { workspaceId } });
    const makeDefault = input.isDefault ?? existingCount === 0;
    const models = this.mergeModels(input.availableModels, resolved.model);

    if (makeDefault) {
      await this.prisma.aiConnection.updateMany({
        where: { workspaceId, isDefault: true },
        data: { isDefault: false },
      });
    }

    const created = await this.prisma.aiConnection.create({
      data: {
        workspaceId,
        name: resolved.name,
        provider: resolved.provider,
        baseUrl: resolved.baseUrl,
        sealedCredentials,
        defaultModel: resolved.model,
        availableModels: models as unknown as Prisma.InputJsonValue,
        capabilities: this.initialCapabilities(
          resolved.provider,
        ) as unknown as Prisma.InputJsonValue,
        status: input.enabled === false ? AiConfigStatus.DISABLED : AiConfigStatus.CONNECTED,
        isDefault: makeDefault,
        updatedById: actor.userId,
      },
    });
    await this.recordActivity(workspaceId, actor, created.name, created.defaultModel);
    return this.toView(created, []);
  }

  async updateConnection(
    workspaceId: string,
    connectionId: string,
    input: SaveAiConnectionInput,
    actor: Actor,
  ): Promise<AiConnectionView> {
    const existing = await this.requireConnection(workspaceId, connectionId);
    if (input.enabled === false) {
      await this.assertNoDependentAgents(workspaceId, connectionId, 'disable');
    }
    const resolved = await this.resolveInputs(workspaceId, existing, input);
    const sealedCredentials = resolved.apiKey
      ? await this.vault.seal(workspaceId, { apiKey: resolved.apiKey })
      : null;
    const makeDefault = input.isDefault ?? existing.isDefault;
    if (makeDefault && !existing.isDefault) {
      await this.prisma.aiConnection.updateMany({
        where: { workspaceId, isDefault: true },
        data: { isDefault: false },
      });
    }
    const models = this.mergeModels(
      input.availableModels ?? parseModelsList(existing.availableModels),
      resolved.model,
    );
    const updated = await this.prisma.aiConnection.update({
      where: { id: connectionId },
      data: {
        name: resolved.name,
        provider: resolved.provider,
        baseUrl: resolved.baseUrl,
        sealedCredentials,
        defaultModel: resolved.model,
        availableModels: models as unknown as Prisma.InputJsonValue,
        status: input.enabled === false ? AiConfigStatus.DISABLED : AiConfigStatus.CONNECTED,
        isDefault: makeDefault,
        lastError: null,
        updatedById: actor.userId,
      },
    });
    const dependents = await this.dependentAgentKeys(workspaceId, connectionId);
    await this.recordActivity(workspaceId, actor, updated.name, updated.defaultModel);
    return this.toView(updated, dependents);
  }

  async deleteConnection(workspaceId: string, connectionId: string, actor: Actor): Promise<void> {
    const existing = await this.requireConnection(workspaceId, connectionId);
    await this.assertNoDependentAgents(workspaceId, connectionId, 'delete');
    await this.prisma.aiConnection.delete({ where: { id: connectionId } });
    if (existing.isDefault) {
      const next = await this.prisma.aiConnection.findFirst({
        where: { workspaceId, status: { not: AiConfigStatus.DISABLED } },
        orderBy: { createdAt: 'asc' },
      });
      if (next) {
        await this.prisma.aiConnection.update({
          where: { id: next.id },
          data: { isDefault: true },
        });
      }
    }
    await this.activity.record(workspaceId, actor, {
      action: ActivityAction.AiConfigCleared,
      subject: { type: ActivitySubjectType.Workspace, id: workspaceId, label: existing.name },
    });
  }

  async testConnection(
    workspaceId: string,
    input: TestAiConnectionInput,
  ): Promise<TestAiConfigResult> {
    const startedAt = performance.now();
    const existing = input.connectionId
      ? await this.prisma.aiConnection.findFirst({
          where: { id: input.connectionId, workspaceId },
        })
      : null;
    try {
      const resolved = await this.resolveInputs(workspaceId, existing, {
        name: existing?.name ?? defaultLabelForProvider(input.provider),
        provider: input.provider,
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        defaultModel: input.model,
      });
      const result = await this.probeProvider(
        resolved.provider,
        resolved.baseUrl,
        resolved.apiKey,
        resolved.model,
      );
      const latencyMs = Math.round(performance.now() - startedAt);
      if (existing) {
        await this.prisma.aiConnection.update({
          where: { id: existing.id },
          data: {
            status: AiConfigStatus.CONNECTED,
            capabilities: result.capabilities as unknown as Prisma.InputJsonValue,
            lastError: null,
            lastTestedAt: new Date(),
          },
        });
      }
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
      if (existing) {
        await this.prisma.aiConnection.update({
          where: { id: existing.id },
          data: { status: AiConfigStatus.ERROR, lastError: message, lastTestedAt: new Date() },
        });
      }
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

  async listModels(
    workspaceId: string,
    input: ListProviderModelsInput,
  ): Promise<ListAiModelsResult> {
    try {
      const existing = input.connectionId
        ? await this.prisma.aiConnection.findFirst({
            where: { id: input.connectionId, workspaceId },
          })
        : null;
      const baseUrl = this.effectiveBaseUrl(input.provider, input.baseUrl ?? existing?.baseUrl);
      const isPrivate =
        input.provider === AiProviderName.OpenAiCompatible &&
        Boolean(baseUrl) &&
        normalizeOpenAiBaseUrl(baseUrl!).isPrivate;
      const apiKey = await this.resolveApiKey(workspaceId, existing, input.apiKey, isPrivate);

      if (input.provider === AiProviderName.Gemini) {
        const gemini = new GeminiAiProvider({ apiKey: apiKey ?? '', model: 'probe' });
        const listed = await gemini.listModels();
        return { supported: listed.supported, models: listed.models, error: null };
      }
      if (
        input.provider === AiProviderName.Anthropic ||
        input.provider === AiProviderName.AnthropicCompatible
      ) {
        const listed = await fetchAnthropicModels(
          baseUrl ?? ANTHROPIC_OFFICIAL_BASE_URL,
          apiKey ?? '',
        );
        return { supported: listed.supported, models: listed.models, error: null };
      }
      if (!baseUrl) throw new BadRequestException('Base URL is required for this provider.');
      const openai = new OpenAiCompatibleAiProvider({
        baseUrl,
        apiKey,
        model: 'probe',
        providerName: input.provider,
      });
      const listed = await openai.listModels();
      return { supported: listed.supported, models: listed.models, error: null };
    } catch (error) {
      return { supported: false, models: [], error: truncateError(error) };
    }
  }

  /**
   * Resolves the exact `AiProvider` for a workspace call or internal agent.
   * Never silently falls back to another provider if an explicitly assigned connection is disabled or fails.
   */
  async resolveForCall(
    workspaceId: string,
    options?: { agentKey?: string | null; connectionId?: string | null },
  ): Promise<ResolvedAiCallProvider> {
    await this.ensureLegacyMigrated(workspaceId);
    const { connection, modelOverride, explicitAssignment } = await this.pickConnection(
      workspaceId,
      options,
    );
    if (!connection) {
      if (explicitAssignment) throw new AiNotConfiguredError();
      const configured = this.defaultProvider.isConfigured();
      return {
        provider: this.defaultProvider,
        connectionId: null,
        source: configured ? AiConfigSource.Environment : AiConfigSource.None,
        configured,
        forceModel: false,
      };
    }
    if (connection.status === AiConfigStatus.DISABLED) {
      throw new AiNotConfiguredError();
    }
    const apiKey = connection.sealedCredentials
      ? (await this.vault.open(workspaceId, connection.sealedCredentials)).apiKey
      : null;
    const providerName = parseProvider(connection.provider);
    const model = modelOverride?.trim() || connection.defaultModel;
    const provider = this.instantiateProvider(providerName, connection.baseUrl, apiKey, model);
    return {
      provider,
      connectionId: connection.id,
      source: AiConfigSource.Workspace,
      configured: provider.isConfigured(),
      forceModel: true,
    };
  }

  async recordOutcome(connectionId: string | null, error: unknown): Promise<void> {
    if (!connectionId) return;
    try {
      if (error === null) {
        await this.prisma.aiConnection.updateMany({
          where: { id: connectionId, lastError: { not: null } },
          data: { status: AiConfigStatus.CONNECTED, lastError: null },
        });
        return;
      }
      if (error instanceof AiNotConfiguredError) return;
      const status =
        error instanceof AiKeyRejectedError ? AiConfigStatus.ERROR : AiConfigStatus.CONNECTED;
      await this.prisma.aiConnection.updateMany({
        where: { id: connectionId },
        data: { status, lastError: truncateError(error) },
      });
    } catch {
      this.logger.debug('Could not persist AI call outcome on connection');
    }
  }

  private async pickConnection(
    workspaceId: string,
    options?: { agentKey?: string | null; connectionId?: string | null },
  ): Promise<{
    connection: AiConnection | null;
    modelOverride: string | null;
    explicitAssignment: boolean;
  }> {
    if (options?.connectionId) {
      const conn = await this.prisma.aiConnection.findFirst({
        where: { id: options.connectionId, workspaceId },
      });
      return { connection: conn, modelOverride: null, explicitAssignment: true };
    }
    if (options?.agentKey) {
      const agentCfg = await this.prisma.workspaceAgentConfig.findUnique({
        where: { workspaceId_agentKey: { workspaceId, agentKey: options.agentKey } },
      });
      if (agentCfg?.aiConnectionId) {
        const conn = await this.prisma.aiConnection.findFirst({
          where: { id: agentCfg.aiConnectionId, workspaceId },
        });
        return { connection: conn, modelOverride: agentCfg.model, explicitAssignment: true };
      }
    }
    const defaultConn = await this.prisma.aiConnection.findFirst({
      where: { workspaceId, isDefault: true },
    });
    if (defaultConn) {
      return { connection: defaultConn, modelOverride: null, explicitAssignment: false };
    }
    const firstActive = await this.prisma.aiConnection.findFirst({
      where: { workspaceId, status: { not: AiConfigStatus.DISABLED } },
      orderBy: { createdAt: 'asc' },
    });
    return { connection: firstActive, modelOverride: null, explicitAssignment: false };
  }

  private effectiveBaseUrl(provider: AiProviderName, raw?: string | null): string | null {
    const trimmed = raw?.trim() || '';
    if (provider === AiProviderName.OpenAi) return OPENAI_OFFICIAL_BASE_URL;
    if (provider === AiProviderName.Gemini) return GEMINI_OFFICIAL_BASE_URL;
    if (provider === AiProviderName.Anthropic) return null;
    if (trimmed) return normalizeOpenAiBaseUrl(trimmed).baseUrl;
    return null;
  }

  private async resolveInputs(
    workspaceId: string,
    existing: AiConnection | null,
    input: {
      name: string;
      provider: AiProviderName;
      baseUrl?: string | null;
      apiKey?: string | null;
      defaultModel: string;
    },
  ): Promise<{
    name: string;
    provider: AiProviderName;
    baseUrl: string | null;
    apiKey: string | null;
    model: string;
  }> {
    const model = input.defaultModel.trim();
    if (!model) throw new BadRequestException('Model identifier is required.');
    const name = input.name.trim() || defaultLabelForProvider(input.provider);
    const baseUrl = this.effectiveBaseUrl(input.provider, input.baseUrl);
    if (requiresCustomBaseUrl(input.provider) && !baseUrl) {
      throw new BadRequestException('Base URL is required for compatible providers.');
    }
    const isPrivate =
      input.provider === AiProviderName.OpenAiCompatible &&
      Boolean(baseUrl) &&
      normalizeOpenAiBaseUrl(baseUrl!).isPrivate;
    const apiKey = await this.resolveApiKey(workspaceId, existing, input.apiKey, isPrivate);
    return { name, provider: input.provider, baseUrl, apiKey, model };
  }

  private async resolveApiKey(
    workspaceId: string,
    existing: AiConnection | null,
    supplied: string | null | undefined,
    allowKeyless: boolean,
  ): Promise<string | null> {
    const trimmed = supplied?.trim() ?? '';
    if (trimmed.length > 0) return trimmed;
    if (existing?.sealedCredentials) {
      return (await this.vault.open(workspaceId, existing.sealedCredentials)).apiKey;
    }
    if (allowKeyless) return null;
    throw new BadRequestException('API key is required for this provider.');
  }

  private instantiateProvider(
    provider: AiProviderName,
    baseUrl: string | null,
    apiKey: string | null,
    model: string,
  ): AiProvider {
    if (provider === AiProviderName.Gemini) {
      if (!apiKey) throw new AiNotConfiguredError();
      return new GeminiAiProvider({ apiKey, model, baseUrl });
    }
    if (provider === AiProviderName.Anthropic || provider === AiProviderName.AnthropicCompatible) {
      if (!apiKey) throw new AiNotConfiguredError();
      return AnthropicAiProvider.fromCredentials(this.anthropicClients, apiKey, model, {
        baseUrl: provider === AiProviderName.AnthropicCompatible ? baseUrl : null,
        providerName: provider,
      });
    }
    return new OpenAiCompatibleAiProvider({
      baseUrl: baseUrl || OPENAI_OFFICIAL_BASE_URL,
      apiKey,
      model,
      providerName: provider,
    });
  }

  private async probeProvider(
    provider: AiProviderName,
    baseUrl: string | null,
    apiKey: string | null,
    model: string,
  ): Promise<{ resolvedModel: string; capabilities: AiCapabilities }> {
    if (provider === AiProviderName.Gemini) {
      if (!apiKey) throw new BadRequestException('API key is required.');
      return new GeminiAiProvider({ apiKey, model, baseUrl }).probeCapabilities();
    }
    if (provider === AiProviderName.OpenAi || provider === AiProviderName.OpenAiCompatible) {
      return new OpenAiCompatibleAiProvider({
        baseUrl: baseUrl || OPENAI_OFFICIAL_BASE_URL,
        apiKey,
        model,
        providerName: provider,
      }).probeCapabilities();
    }
    if (!apiKey) throw new BadRequestException('API key is required.');
    const instance = AnthropicAiProvider.fromCredentials(this.anthropicClients, apiKey, model, {
      baseUrl: provider === AiProviderName.AnthropicCompatible ? baseUrl : null,
      providerName: provider,
    });
    const completion = await instance.complete({
      system: 'Return JSON with ok=true.',
      prompt: 'ping',
      schema: z.object({ ok: z.boolean() }),
      maxOutputTokens: PROBE_MAX_TOKENS,
    });
    const listed = await fetchAnthropicModels(baseUrl ?? ANTHROPIC_OFFICIAL_BASE_URL, apiKey).catch(
      () => ({ supported: false, models: [] }),
    );
    return {
      resolvedModel: completion.model,
      capabilities: { ...ANTHROPIC_DEFAULT_CAPABILITIES, modelsEndpoint: listed.supported },
    };
  }

  private initialCapabilities(provider: AiProviderName): AiCapabilities {
    if (provider === AiProviderName.Anthropic) return { ...ANTHROPIC_DEFAULT_CAPABILITIES };
    return { ...UNKNOWN_AI_CAPABILITIES };
  }

  private mergeModels(list: readonly string[] | undefined, activeModel: string): string[] {
    const set = new Set<string>(
      (list ?? []).map((item) => item.trim()).filter((item) => item.length > 0),
    );
    if (activeModel.trim()) set.add(activeModel.trim());
    return [...set];
  }

  private async requireConnection(
    workspaceId: string,
    connectionId: string,
  ): Promise<AiConnection> {
    const found = await this.prisma.aiConnection.findFirst({
      where: { id: connectionId, workspaceId },
    });
    if (!found) throw new NotFoundException('AI connection not found.');
    return found;
  }

  private async dependentAgentKeys(workspaceId: string, connectionId: string): Promise<string[]> {
    const rows = await this.prisma.workspaceAgentConfig.findMany({
      where: { workspaceId, aiConnectionId: connectionId },
      select: { agentKey: true },
    });
    return rows.map((row) => row.agentKey);
  }

  private async assertNoDependentAgents(
    workspaceId: string,
    connectionId: string,
    action: 'delete' | 'disable',
  ): Promise<void> {
    const dependents = await this.dependentAgentKeys(workspaceId, connectionId);
    if (dependents.length > 0) {
      throw new ConflictException(
        `Cannot ${action} this AI connection because it is assigned to: ${dependents.join(', ')}. Reassign those agents first.`,
      );
    }
  }

  private async recordActivity(
    workspaceId: string,
    actor: Actor,
    label: string,
    model: string,
  ): Promise<void> {
    await this.activity.record(workspaceId, actor, {
      action: ActivityAction.AiConfigUpdated,
      subject: { type: ActivitySubjectType.Workspace, id: workspaceId, label },
      detail: model,
    });
  }

  private toView(record: AiConnection, usedByAgents: string[]): AiConnectionView {
    return {
      id: record.id,
      name: record.name,
      provider: parseProvider(record.provider),
      baseUrl: record.baseUrl,
      defaultModel: record.defaultModel,
      availableModels: parseModelsList(record.availableModels),
      hasApiKey: Boolean(record.sealedCredentials),
      status: record.status,
      isDefault: record.isDefault,
      capabilities: parseCapabilities(record.capabilities),
      usedByAgents,
      lastError: record.lastError,
      lastTestedAt: record.lastTestedAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }
}
