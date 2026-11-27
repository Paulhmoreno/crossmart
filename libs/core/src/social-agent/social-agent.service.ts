import { Injectable } from '@nestjs/common';
import { AiConfigStatus, PrismaService } from '@crossmart/database';
import { AiContentBlockType } from '../ai/enums/ai-content-block-type.enum.js';
import { AiConversationRole } from '../ai/enums/ai-conversation-role.enum.js';
import { AiFeature } from '../ai/enums/ai-feature.enum.js';
import {
  AgentExecutionEngine,
  type AgentExecutionResult,
  type AgentStreamSink,
} from '../ai/services/agent-execution-engine.service.js';
import { AgentConfigsService } from '../sales-agent/agent-configs.service.js';
import { SalesKnowledgeService } from '../sales-agent/sales-knowledge.service.js';
import { SocialAgentToolsService } from './social-agent-tools.service.js';
import { SocialIntelligenceService } from './social-intelligence.service.js';
import { TryPostConnectionService } from './trypost-connection.service.js';

const MAX_SUPERVISOR_OUTPUT_TOKENS = 1400;
const MAX_SUPERVISOR_STEPS = 6;

export type SocialNodeStatus = 'ok' | 'warning' | 'error' | 'unconfigured';

export interface SocialOperationalNode {
  id: string;
  label: string;
  status: SocialNodeStatus;
  summary: string;
  details: Record<string, unknown>;
}

/**
 * Universal Social Marketing Agent (`Agente Social`):
 * Organic marketing strategist, Community Manager, and creative director for any Crossmart workspace.
 * Zero hardcoded brands, characters, industries, or fixed content templates.
 */
@Injectable()
export class SocialAgentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: AgentExecutionEngine,
    private readonly tools: SocialAgentToolsService,
    private readonly agentConfigs: AgentConfigsService,
    private readonly knowledge: SalesKnowledgeService,
    private readonly intelligence: SocialIntelligenceService,
    private readonly trypost: TryPostConnectionService,
  ) {}

  async getOperationalOverview(workspaceId: string) {
    const [
      agentConfig,
      aiConns,
      trypostConn,
      opportunities,
      knowledgeEntries,
      profiles,
      items,
      policy,
      events,
    ] = await Promise.all([
      this.agentConfigs.get(workspaceId, 'social'),
      this.prisma.workspaceAiConfig.findMany({
        where: { workspaceId, status: AiConfigStatus.CONNECTED },
        select: { id: true, provider: true, model: true },
      }),
      this.trypost.getStatus(workspaceId),
      this.intelligence.analyzeBusinessOpportunities(workspaceId),
      this.knowledge.listEntries(workspaceId),
      this.intelligence.listCreativeProfiles(workspaceId),
      this.intelligence.listContentItems(workspaceId),
      this.intelligence.getOrCreatePolicy(workspaceId),
      this.prisma.socialAgentEvent.findMany({
        where: { workspaceId },
        orderBy: { createdAt: 'desc' },
        take: 40,
      }),
    ]);

    const assignedAi =
      aiConns.find((c) => c.id === agentConfig.aiConnectionId) ??
      aiConns[0] ??
      null;

    const pendingApprovals = items.filter((item: { status: string }) => item.status === 'PENDING_APPROVAL').length;
    const inProduction = items.filter(
      (item: { status: string }) =>
        item.status === 'IN_PRODUCTION' || item.status === 'IDEA' || item.status === 'DRAFT_REMOTE',
    ).length;
    const scheduledOrPublished = items.filter(
      (item: { status: string }) => item.status === 'SCHEDULED' || item.status === 'PUBLISHED',
    ).length;

    const trypostConnected = trypostConn?.status === 'CONNECTED';
    const trypostError = trypostConn?.status === 'ERROR';

    const nodes: SocialOperationalNode[] = [
      {
        id: 'catalog',
        label: 'Catálogo',
        status: opportunities.totalProducts > 0 ? 'ok' : 'warning',
        summary:
          opportunities.totalProducts > 0
            ? `${opportunities.inStockProducts} con stock de ${opportunities.totalProducts} producto(s)`
            : 'Sin productos en catálogo',
        details: {
          totalProducts: opportunities.totalProducts,
          inStockProducts: opportunities.inStockProducts,
          topCategories: opportunities.topCategories,
        },
      },
      {
        id: 'knowledge',
        label: 'Conocimiento',
        status: knowledgeEntries.length > 0 || profiles.length > 0 ? 'ok' : 'warning',
        summary: `${knowledgeEntries.length} regla(s) · ${profiles.length} perfil(es) creativo(s)`,
        details: {
          knowledgeCount: knowledgeEntries.length,
          creativeProfilesCount: profiles.length,
        },
      },
      {
        id: 'research',
        label: 'Investigación',
        status: opportunities.opportunities.length > 0 ? 'ok' : 'unconfigured',
        summary: `${opportunities.opportunities.length} oportunidad(es) detectada(s)`,
        details: { opportunities: opportunities.opportunities },
      },
      {
        id: 'ai',
        label: 'Inteligencia artificial',
        status: assignedAi ? 'ok' : 'unconfigured',
        summary: assignedAi
          ? `${assignedAi.provider} · ${agentConfig.model ?? assignedAi.model ?? 'default'}`
          : 'Sin proveedor de IA activo',
        details: {
          provider: assignedAi?.provider ?? null,
          model: agentConfig.model ?? assignedAi?.model ?? null,
        },
      },
      {
        id: 'production',
        label: 'Producción',
        status: items.length > 0 ? 'ok' : 'unconfigured',
        summary: `${inProduction} en preparación · composición SVG y flujo asistido activos`,
        details: { inProduction, totalItems: items.length },
      },
      {
        id: 'trypost',
        label: 'TryPost',
        status: trypostConnected ? 'ok' : trypostError ? 'error' : 'unconfigured',
        summary: trypostConnected
          ? `${trypostConn.channels.length} cuenta(s) social(es) conectada(s)`
          : trypostError
            ? (trypostConn?.statusReason ?? 'Error de autenticación')
            : 'No conectado (modo estrategia y producción local activo)',
        details: {
          connected: trypostConnected,
          channels: trypostConn?.channels ?? [],
          capabilities: trypostConn?.capabilities ?? {},
        },
      },
      {
        id: 'approvals',
        label: 'Aprobaciones',
        status: pendingApprovals > 0 ? 'warning' : 'ok',
        summary:
          pendingApprovals > 0
            ? `${pendingApprovals} pieza(s) esperando revisión`
            : 'Sin aprobaciones pendientes',
        details: {
          pendingApprovals,
          autoPublishAuthorized: policy.autoPublishAuthorized,
          autonomyMode: policy.autonomyMode,
        },
      },
      {
        id: 'planning',
        label: 'Planificación',
        status: policy.paused ? 'warning' : scheduledOrPublished > 0 ? 'ok' : 'unconfigured',
        summary: policy.paused
          ? 'Planificación pausada'
          : `${policy.planningFrequency} · ${scheduledOrPublished} programada(s)/publicada(s)`,
        details: {
          paused: policy.paused,
          planningFrequency: policy.planningFrequency,
          timezone: policy.timezone,
        },
      },
      {
        id: 'results',
        label: 'Resultados',
        status: trypostConnected && trypostConn.capabilities.analytics ? 'ok' : 'unconfigured',
        summary:
          trypostConnected && trypostConn.capabilities.analytics
            ? 'Analítica de TryPost disponible'
            : 'Conecta TryPost para recuperar métricas sociales reales',
        details: {
          analyticsAvailable: Boolean(trypostConnected && trypostConn.capabilities.analytics),
        },
      },
    ];

    return {
      agentKey: 'social' as const,
      nodes,
      policy,
      trypost: trypostConn,
      opportunities,
      profiles,
      items,
      events,
    };
  }

  /** Cancels an active Social Agent Supervisor turn by turnId. */
  cancelSupervisorTurn(turnId: string): boolean {
    return this.engine.cancelTurn(turnId);
  }

  /**
   * Streaming Supervisor execution for Agente Social via Crossmart's shared `AgentExecutionEngine`.
   * Executes real TryPost, catalog, knowledge, and Production tools and delivers structured results
   * back to the model until a grounded final answer is produced.
   */
  async streamSupervisorTurn(
    workspaceId: string,
    input: {
      message: string;
      history?: Array<{ role: 'user' | 'assistant'; text: string }>;
      locale?: string;
      conversationKey?: string;
    },
    sink?: AgentStreamSink,
    externalSignal?: AbortSignal,
  ): Promise<AgentExecutionResult & { opportunitiesUsed: number }> {
    const [workspace, opportunities, knowledgeEntries, profiles, trypostConn, policy] =
      await Promise.all([
        this.prisma.workspace.findUnique({
          where: { id: workspaceId },
          select: { name: true, currency: true },
        }),
        this.intelligence.analyzeBusinessOpportunities(workspaceId),
        this.knowledge.listEntries(workspaceId),
        this.intelligence.listCreativeProfiles(workspaceId),
        this.trypost.getStatus(workspaceId),
        this.intelligence.getOrCreatePolicy(workspaceId),
      ]);

    const contextSummary = [
      `Workspace: ${workspace?.name ?? 'Workspace'} (currency: ${workspace?.currency ?? 'USD'}).`,
      `Catalog: ${opportunities.totalProducts} total product(s), ${opportunities.inStockProducts} in stock. Top categories: ${opportunities.topCategories.join(', ') || 'none'}.`,
      knowledgeEntries.length > 0
        ? `Approved commercial knowledge:\n${knowledgeEntries
            .slice(0, 12)
            .map((k) => `- ${k.title}: ${k.content}`)
            .join('\n')}`
        : 'No approved commercial knowledge entries yet.',
      profiles.length > 0
        ? `Creative profiles:\n${profiles
            .slice(0, 5)
            .map((p) => `- ${p.name}: ${p.instructions.slice(0, 300)}`)
            .join('\n')}`
        : 'No custom creative profiles configured yet.',
      trypostConn?.status === 'CONNECTED'
        ? `TryPost connected (${trypostConn.channels.length} cached account(s)). Use TryPost tools to inspect live accounts, posts, ideas, and analytics.`
        : 'TryPost not connected yet (strategy, ideas, copy, scripts, and local Production drafts are available).',
      `Operating policy: mode=${policy.autonomyMode}, autoPublish=${policy.autoPublishAuthorized ? 'enabled' : 'disabled'}, paused=${policy.paused ? 'yes' : 'no'}.`,
    ].join('\n');

    const systemPrompt = [
      'You are Crossmart Social Agent: organic marketing strategist, Community Manager, and creative director.',
      'Mandatory operating rules:',
      '1. Respond in clear, actionable, commercial natural language. Never expose UUIDs, database table names, or internal codes.',
      '2. Always call your real tools when asked to inspect TryPost accounts, posts, calendar, ideas, analytics, catalog opportunities, or Production items. Never invent or guess remote data.',
      '3. Never promote out-of-stock products automatically unless the owner explicitly requests a pre-sale or upcoming restock.',
      '4. Balance commercial, educational, informative, and brand-building content.',
      '5. Respect approvals and safety limits: never schedule or publish content automatically, and never claim something was published without confirmed execution.',
      '',
      'Current workspace snapshot:',
      contextSummary,
    ].join('\n');

    const messages = [
      ...(input.history ?? []).slice(-12).map((m) => ({
        role: m.role === 'user' ? AiConversationRole.User : AiConversationRole.Assistant,
        content: [{ type: AiContentBlockType.Text as const, text: m.text }],
      })),
      {
        role: AiConversationRole.User,
        content: [{ type: AiContentBlockType.Text as const, text: input.message.trim() }],
      },
    ];

    const result = await this.engine.runTurn(
      {
        workspaceId,
        agentKey: 'social',
        feature: AiFeature.SalesAgent,
        conversationKey: input.conversationKey ?? `${workspaceId}:social:supervisor`,
        systemPrompt,
        locale: input.locale ?? 'es-EC',
        messages,
        tools: this.tools.buildTools(workspaceId),
        maxSteps: MAX_SUPERVISOR_STEPS,
        maxOutputTokens: MAX_SUPERVISOR_OUTPUT_TOKENS,
        externalSignal,
        fallbackText:
          input.locale?.toLowerCase().startsWith('en')
            ? 'I completed checking your workspace tools, but the AI provider returned an empty final summary. Please try again.'
            : 'Completé la consulta de herramientas del espacio de trabajo, pero el proveedor de IA devolvió un resumen vacío. Inténtalo de nuevo.',
      },
      sink,
    );

    await this.prisma.socialAgentEvent
      .create({
        data: {
          workspaceId,
          eventType: 'supervisor_chat',
          summary: `Consulta al Supervisor de Agente Social: "${input.message.trim().slice(0, 70)}"`,
          severity: result.status === 'failed' ? 'warn' : 'info',
          metadata: {
            turnId: result.turnId,
            status: result.status,
            toolsUsed: result.toolsUsed,
          },
        },
      })
      .catch(() => undefined);

    return { ...result, opportunitiesUsed: opportunities.opportunities.length };
  }

  /**
   * Synchronous wrapper over `streamSupervisorTurn` for backward compatibility.
   */
  async chatWithSupervisor(
    workspaceId: string,
    input: {
      message: string;
      history?: Array<{ role: 'user' | 'assistant'; text: string }>;
      locale?: string;
    },
  ): Promise<{
    reply: string;
    opportunitiesUsed: number;
    turnId: string;
    status: string;
    toolsUsed: string[];
  }> {
    const result = await this.streamSupervisorTurn(workspaceId, input);
    const reply =
      result.text ||
      (result.error
        ? `No se pudo completar la respuesta (${result.error}).`
        : 'No se recibió respuesta del proveedor de IA.');
    return {
      reply,
      opportunitiesUsed: result.opportunitiesUsed,
      turnId: result.turnId,
      status: result.status,
      toolsUsed: result.toolsUsed,
    };
  }
}
