import { Injectable } from '@nestjs/common';
import { AiConfigStatus, type Prisma, PrismaService } from '@crossmart/database';
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

const MAX_SUPERVISOR_OUTPUT_TOKENS = 1800;
const MAX_SUPERVISOR_STEPS = 10;
const SOCIAL_CONVERSATION_SOURCE = 'social_supervisor';

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
   * Server-side persistent conversations for Agente Social Supervisor (reusing PostgreSQL
   * `SalesConversation` + `SalesMessage` scoped by workspaceId with `source = 'social_supervisor'`).
   */
  async listSupervisorConversations(workspaceId: string) {
    return this.prisma.salesConversation.findMany({
      where: { workspaceId, source: SOCIAL_CONVERSATION_SOURCE },
      orderBy: { updatedAt: 'desc' },
      take: 30,
      select: { id: true, title: true, createdAt: true, updatedAt: true },
    });
  }

  async getOrCreateLatestConversation(workspaceId: string, conversationId?: string | null) {
    if (conversationId) {
      const found = await this.prisma.salesConversation.findFirst({
        where: { id: conversationId, workspaceId, source: SOCIAL_CONVERSATION_SOURCE },
        include: { messages: { orderBy: { createdAt: 'asc' }, take: 60 } },
      });
      if (found) return found;
    }
    const latest = await this.prisma.salesConversation.findFirst({
      where: { workspaceId, source: SOCIAL_CONVERSATION_SOURCE },
      orderBy: { updatedAt: 'desc' },
      include: { messages: { orderBy: { createdAt: 'asc' }, take: 60 } },
    });
    if (latest) return latest;
    return this.prisma.salesConversation.create({
      data: {
        workspaceId,
        source: SOCIAL_CONVERSATION_SOURCE,
        title: 'Social Supervisor',
      },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
  }

  async createSupervisorConversation(workspaceId: string, title?: string) {
    return this.prisma.salesConversation.create({
      data: {
        workspaceId,
        source: SOCIAL_CONVERSATION_SOURCE,
        title: title?.trim() || 'Social Supervisor',
      },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
  }

  async deleteSupervisorConversation(workspaceId: string, conversationId: string): Promise<void> {
    await this.prisma.salesConversation.deleteMany({
      where: { id: conversationId, workspaceId, source: SOCIAL_CONVERSATION_SOURCE },
    });
  }

  /**
   * Streaming Supervisor execution for Agente Social via Crossmart's shared `AgentExecutionEngine`.
   * Executes real TryPost, catalog, photo upload, remote draft, and Production tools and persists
   * every turn in PostgreSQL.
   */
  async streamSupervisorTurn(
    workspaceId: string,
    input: {
      message: string;
      conversationId?: string | null;
      history?: Array<{ role: 'user' | 'assistant'; text: string }>;
      locale?: string;
      conversationKey?: string;
    },
    sink?: AgentStreamSink,
    externalSignal?: AbortSignal,
  ): Promise<AgentExecutionResult & { opportunitiesUsed: number; conversationId: string }> {
    const conv = await this.getOrCreateLatestConversation(workspaceId, input.conversationId);
    const trimmedMessage = input.message.trim();

    await this.prisma.salesMessage.create({
      data: { conversationId: conv.id, role: 'supervisor', text: trimmedMessage },
    });

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
      `Full catalog totals: ${opportunities.totalProducts} total product(s), ${opportunities.inStockProducts} in stock (${opportunities.multiUnitProducts} multi-unit, ${opportunities.singleUnitProducts} single-unit). Top categories: ${opportunities.topCategories.join(', ') || 'none'}.`,
      knowledgeEntries.length > 0
        ? `Approved commercial knowledge (RESPECT SCOPE — never apply marketplace-only policies to social networks):\n${knowledgeEntries
            .slice(0, 12)
            .map((k) => `- [scope: ${k.scope}] ${k.title}: ${k.content}`)
            .join('\n')}`
        : 'No approved commercial knowledge entries yet.',
      profiles.length > 0
        ? `Creative profiles:\n${profiles
            .slice(0, 5)
            .map((p) => `- ${p.name}: ${p.instructions.slice(0, 300)}`)
            .join('\n')}`
        : 'No custom creative profiles configured yet.',
      trypostConn?.status === 'CONNECTED'
        ? `TryPost connected (${trypostConn.channels.length} cached account(s)). Use TryPost tools to inspect live accounts, posts, ideas, queue slots, analytics, upload real catalog photos (upload_trypost_media), save ideas (save_trypost_idea), and create remote drafts (create_trypost_draft).`
        : 'TryPost not connected yet (strategy, ideas, copy, scripts, and local Production drafts are available).',
      `Operating policy: mode=${policy.autonomyMode}, autoPublish=${policy.autoPublishAuthorized ? 'enabled' : 'disabled'}, paused=${policy.paused ? 'yes' : 'no'}.`,
    ].join('\n');

    const systemPrompt = [
      'You are Crossmart Social Agent: organic marketing strategist, Community Manager, and creative director.',
      'MANDATORY CONFIDENTIALITY & COMMERCIAL ACCURACY RULES:',
      '1. NEVER expose internal margins, profit percentages, acquisition costs, supplier info, or internal strategies in any public post, idea, caption, or draft. Keep all public copy strictly customer-facing.',
      '2. NEVER invent product specifications, arrival dates ("recién llegado"), testimonials, physical tests/unboxings already performed, promotions, or delivery terms not verified in catalog/knowledge.',
      '3. Respect policy scope strictly: NEVER copy a Mercado Libre / Marketplace shipping or payment policy onto Facebook, Instagram, TikTok, or YouTube unless its scope is global or matches that channel.',
      '4. Never promote out-of-stock products automatically, and avoid wasting creative effort on single-unit stock when multi-unit in-stock products are available.',
      '5. Always call your real tools when asked to inspect TryPost accounts, analyze the full catalog, retrieve real catalog photos (`get_catalog_product_images`), upload a photo (`upload_trypost_media`), save ideas (`save_trypost_idea`), or create a remote draft (`create_trypost_draft`).',
      '6. NEVER schedule or publish content automatically. Clearly distinguish executed actions, created remote drafts/ideas, and pending human approvals. Do not repeat raw tool-log lists redundantly.',
      '7. Respond in clear, natural commercial language without exposing UUIDs, database table names, or internal codes.',
      '',
      'Current workspace snapshot:',
      contextSummary,
    ].join('\n');

    const dbHistory = conv.messages.slice(-12).map((m) => ({
      role: m.role === 'supervisor' ? AiConversationRole.User : AiConversationRole.Assistant,
      content: [{ type: AiContentBlockType.Text as const, text: m.text }],
    }));

    const messages = [
      ...dbHistory,
      {
        role: AiConversationRole.User,
        content: [{ type: AiContentBlockType.Text as const, text: trimmedMessage }],
      },
    ];

    const result = await this.engine.runTurn(
      {
        workspaceId,
        agentKey: 'social',
        feature: AiFeature.SalesAgent,
        conversationKey: input.conversationKey ?? `${workspaceId}:social:${conv.id}`,
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

    if (result.text || result.toolRuns.length > 0) {
      await this.prisma.salesMessage.create({
        data: {
          conversationId: conv.id,
          role: 'assistant',
          text:
            result.text ||
            (result.status === 'cancelled'
              ? 'Ejecución cancelada.'
              : result.error || 'No se recibió respuesta.'),
          metadata: {
            turnId: result.turnId,
            status: result.status,
            toolsUsed: result.toolsUsed,
            toolRuns: result.toolRuns,
          } as unknown as Prisma.InputJsonValue,
        },
      });
    }

    await this.prisma.salesConversation.update({
      where: { id: conv.id },
      data: {
        ...(conv.title === 'Social Supervisor' ? { title: trimmedMessage.slice(0, 60) } : {}),
        updatedAt: new Date(),
      },
    });

    await this.prisma.socialAgentEvent
      .create({
        data: {
          workspaceId,
          eventType: 'supervisor_chat',
          summary: `Consulta al Supervisor de Agente Social: "${trimmedMessage.slice(0, 70)}"`,
          severity: result.status === 'failed' ? 'warn' : 'info',
          metadata: {
            turnId: result.turnId,
            conversationId: conv.id,
            status: result.status,
            toolsUsed: result.toolsUsed,
          },
        },
      })
      .catch(() => undefined);

    return {
      ...result,
      opportunitiesUsed: opportunities.opportunities.length,
      conversationId: conv.id,
    };
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
