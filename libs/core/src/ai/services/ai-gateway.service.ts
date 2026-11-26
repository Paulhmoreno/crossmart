import { Injectable, Logger, Optional } from '@nestjs/common';
import { AI_CREDITS_PER_CALL } from '../../entitlements/entitlements.constants.js';
import { Feature } from '../../entitlements/enums/feature.enum.js';
import { SandboxRestriction } from '../../entitlements/enums/sandbox-restriction.enum.js';
import { EntitlementService } from '../../entitlements/services/entitlement.service.js';
import type {
  AiCallContext,
  AiPlatformCallContext,
  AiCompletion,
  AiGeneration,
  AiStatus,
  AiStructuredRequest,
} from '../entities/ai-completion.js';
import type {
  AiConversationContext,
  AiConversationListener,
  AiConversationReply,
  AiConversationRequest,
} from '../entities/ai-conversation.js';
import type { AiFeature } from '../enums/ai-feature.enum.js';
import { AiNotConfiguredError, AiOutputRejectedError } from '../errors/ai.errors.js';
import { AiProvider } from '../providers/ai-provider.js';
import { parseStructuredOutput } from '../rules/structured-output.js';
import { AiConfigService } from './ai-config.service.js';
import { AiConnectionsService } from './ai-connections.service.js';
import { AiUsageService } from './ai-usage.service.js';

const ONE_CALL = 1;

/**
 * The one door to the AI provider. Every call first needs AI credits left on the plan, is
 * metered (even when its answer is then rejected, as the tokens were spent) and has its answer
 * validated against its schema. Prompts and answers are never logged.
 */
@Injectable()
export class AiGateway {
  private readonly logger = new Logger(AiGateway.name);

  constructor(
    private readonly provider: AiProvider,
    private readonly usage: AiUsageService,
    private readonly entitlements: EntitlementService,
    @Optional() private readonly configs?: AiConfigService,
    @Optional() private readonly connections?: AiConnectionsService,
  ) {}

  status(): AiStatus {
    return {
      configured: this.provider.isConfigured(),
      provider: this.provider.name,
      model: this.provider.model,
    };
  }

  async statusForWorkspace(workspaceId: string, agentKey?: string): Promise<AiStatus> {
    if (this.connections) {
      try {
        const resolved = await this.connections.resolveForCall(workspaceId, { agentKey });
        return {
          configured: resolved.configured,
          provider: resolved.provider.name,
          model: resolved.provider.model,
        };
      } catch {
        return { configured: false, provider: this.provider.name, model: this.provider.model };
      }
    }
    if (!this.configs) return this.status();
    const view = await this.configs.getConfig(workspaceId);
    return {
      configured: view.configured,
      provider: view.provider,
      model: view.model,
    };
  }

  /** Throws `AiNotConfiguredError` when no provider key is set, so callers can refuse early. */
  assertConfigured(): void {
    if (!this.provider.isConfigured()) {
      throw new AiNotConfiguredError();
    }
  }

  async assertConfiguredForWorkspace(workspaceId: string, agentKey?: string): Promise<void> {
    if (this.connections) {
      const resolved = await this.connections.resolveForCall(workspaceId, { agentKey });
      if (!resolved.configured) throw new AiNotConfiguredError();
      return;
    }
    if (!this.configs) {
      this.assertConfigured();
      return;
    }
    const resolved = await this.configs.resolveForWorkspace(workspaceId);
    if (!resolved.configured) {
      throw new AiNotConfiguredError();
    }
  }

  /**
   * Throws `EntitlementExceededException` (HTTP 402, `plan_limit_reached`) when plans are
   * enforced and the organization's AI credits this month do not cover `calls` more calls, and
   * `SandboxRestrictedException` (403) in an unclaimed sandbox account, which Crossmart's AI
   * does not serve.
   */
  async assertCredits(workspaceId: string, calls = ONE_CALL): Promise<void> {
    await this.entitlements.assertSandboxAllows(workspaceId, SandboxRestriction.GenerateContent);
    return this.entitlements.assertInWorkspace(
      workspaceId,
      Feature.AiCredits,
      calls * AI_CREDITS_PER_CALL,
    );
  }

  async generate<Output>(
    context: AiCallContext,
    request: AiStructuredRequest<Output>,
  ): Promise<AiGeneration<Output>> {
    const resolved = await this.resolveProvider(context);
    await this.assertCredits(context.workspaceId);
    const effectiveRequest = resolved.forceModel
      ? { ...request, model: resolved.provider.model }
      : request;
    let completion: AiCompletion;
    try {
      completion = await resolved.provider.complete(effectiveRequest);
      await this.recordOutcome(context.workspaceId, resolved.connectionId, null);
    } catch (error) {
      await this.recordOutcome(context.workspaceId, resolved.connectionId, error);
      throw error;
    }
    await this.meter(context, resolved.provider.name, resolved.connectionId, completion);
    return this.validate(context.feature, completion, effectiveRequest);
  }

  /**
   * One call of a conversation with tools (Agent Worker / Sales Agent), streamed.
   */
  async converse(
    context: AiConversationContext,
    request: AiConversationRequest,
    listener: AiConversationListener,
  ): Promise<AiConversationReply> {
    const resolved = await this.resolveProvider(context);
    await this.assertCredits(context.workspaceId);
    const effectiveRequest = resolved.forceModel
      ? { ...request, model: resolved.provider.model }
      : request;
    let reply: AiConversationReply;
    try {
      reply = await resolved.provider.converse(effectiveRequest, listener);
      await this.recordOutcome(context.workspaceId, resolved.connectionId, null);
    } catch (error) {
      await this.recordOutcome(context.workspaceId, resolved.connectionId, error);
      throw error;
    }
    await this.usage.record({
      workspaceId: context.workspaceId,
      feature: context.feature,
      provider: resolved.provider.name,
      model: reply.model,
      ...(context.agentKey ? { agentKey: context.agentKey } : {}),
      ...(resolved.connectionId ? { connectionId: resolved.connectionId } : {}),
      ...reply.usage,
    });
    return reply;
  }

  /**
   * A call Crossmart pays for itself, outside any workspace (Ask Crossmart). It spends no plan
   * credits, so the caller must bound it (rate limits, a daily cap); it is metered apart, in
   * `platform_ai_usage`, and validated like any other.
   */
  async generateForPlatform<Output>(
    context: AiPlatformCallContext,
    request: AiStructuredRequest<Output>,
  ): Promise<AiGeneration<Output>> {
    this.assertConfigured();
    const completion = await this.provider.complete(request);
    await this.usage.recordPlatform({
      feature: context.feature,
      provider: this.provider.name,
      model: completion.model,
      ...completion.usage,
    });
    return this.validate(context.feature, completion, request);
  }

  private async resolveProvider(context: {
    workspaceId: string;
    agentKey?: string | null;
    connectionId?: string | null;
  }): Promise<{
    provider: AiProvider;
    connectionId: string | null;
    forceModel: boolean;
  }> {
    if (this.connections) {
      const resolved = await this.connections.resolveForCall(context.workspaceId, {
        agentKey: context.agentKey,
        connectionId: context.connectionId,
      });
      if (!resolved.configured) throw new AiNotConfiguredError();
      return {
        provider: resolved.provider,
        connectionId: resolved.connectionId,
        forceModel: resolved.forceModel,
      };
    }
    if (!this.configs) {
      this.assertConfigured();
      return { provider: this.provider, connectionId: null, forceModel: false };
    }
    const resolved = await this.configs.resolveForWorkspace(context.workspaceId);
    if (!resolved.configured) {
      throw new AiNotConfiguredError();
    }
    return { provider: resolved.provider, connectionId: null, forceModel: resolved.forceModel };
  }

  private async recordOutcome(
    workspaceId: string,
    connectionId: string | null,
    error: unknown,
  ): Promise<void> {
    if (connectionId && this.connections) {
      await this.connections.recordOutcome(connectionId, error);
      return;
    }
    await this.configs?.recordCallOutcome(workspaceId, error);
  }

  private validate<Output>(
    feature: AiFeature,
    completion: AiCompletion,
    request: AiStructuredRequest<Output>,
  ): AiGeneration<Output> {
    try {
      return { output: parseStructuredOutput(completion, request.schema), model: completion.model };
    } catch (error) {
      if (error instanceof AiOutputRejectedError) {
        this.logger.warn(`Rejected ${feature} output: ${error.reason}`);
      }
      throw error;
    }
  }

  private meter(
    context: AiCallContext,
    provider: AiProvider['name'],
    connectionId: string | null,
    completion: AiCompletion,
  ): Promise<void> {
    return this.usage.record({
      workspaceId: context.workspaceId,
      feature: context.feature,
      provider,
      model: completion.model,
      ...(context.agentKey ? { agentKey: context.agentKey } : {}),
      ...(connectionId ? { connectionId } : {}),
      ...completion.usage,
    });
  }
}
