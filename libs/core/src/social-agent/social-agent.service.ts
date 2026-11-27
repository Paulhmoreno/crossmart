import { Injectable, Logger } from '@nestjs/common';
import { AiConfigStatus, PrismaService } from '@crossmart/database';
import { AiContentBlockType } from '../ai/enums/ai-content-block-type.enum.js';
import { AiConversationRole } from '../ai/enums/ai-conversation-role.enum.js';
import { AiFeature } from '../ai/enums/ai-feature.enum.js';
import { AiGateway } from '../ai/services/ai-gateway.service.js';
import { AgentConfigsService } from '../sales-agent/agent-configs.service.js';
import { SalesKnowledgeService } from '../sales-agent/sales-knowledge.service.js';
import { SocialIntelligenceService } from './social-intelligence.service.js';
import { TryPostConnectionService } from './trypost-connection.service.js';

const MAX_SUPERVISOR_OUTPUT_TOKENS = 1100;

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
  private readonly logger = new Logger(SocialAgentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiGateway,
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

  /**
   * Natural-language Supervisor conversation for Agente Social.
   * Dynamically adapts to ANY workspace sector using real catalog, shared business knowledge,
   * optional creative profiles, and real TryPost status. Never exposes UUIDs or table names.
   */
  async chatWithSupervisor(
    workspaceId: string,
    input: { message: string; history?: Array<{ role: 'user' | 'assistant'; text: string }> },
  ): Promise<{ reply: string; opportunitiesUsed: number }> {
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
      `Negocio: ${workspace?.name ?? 'Workspace'} (moneda: ${workspace?.currency ?? 'USD'}).`,
      `Catálogo: ${opportunities.totalProducts} producto(s) totales, ${opportunities.inStockProducts} con stock positivo. Categorías principales: ${opportunities.topCategories.join(', ') || 'sin categorizar'}.`,
      `Oportunidades comerciales detectadas:`,
      ...opportunities.opportunities.map((op) => `- [${op.suggestedPillar}] ${op.title}: ${op.rationale}`),
      knowledgeEntries.length > 0
        ? `Conocimiento comercial compartido:\n${knowledgeEntries
            .slice(0, 12)
            .map((k) => `- ${k.title}: ${k.content}`)
            .join('\n')}`
        : 'Sin reglas de conocimiento comercial registradas aún.',
      profiles.length > 0
        ? `Perfiles creativos configurados:\n${profiles
            .slice(0, 5)
            .map((p) => `- ${p.name}: ${p.instructions.slice(0, 300)}`)
            .join('\n')}`
        : 'Sin perfiles creativos personalizados (desarrolla dirección creativa original adaptada al negocio).',
      trypostConn?.status === 'CONNECTED'
        ? `TryPost conectado con ${trypostConn.channels.length} cuenta(s): ${trypostConn.channels.map((c) => `${c.platform}:${c.name}`).join(', ')}.`
        : 'TryPost no conectado todavía (puedes entregar estrategias, ideas, copies, guiones y composiciones listas para exportar).',
      `Política operativa: modo ${policy.autonomyMode}, publicación automática ${policy.autoPublishAuthorized ? 'autorizada' : 'desactivada'}, pausado: ${policy.paused ? 'sí' : 'no'}.`,
    ].join('\n');

    const system = [
      'Eres Agente Social de Crossmart: estratega de marketing orgánico, Community Manager y director creativo.',
      'Reglas obligatorias:',
      '1. Responde en lenguaje natural, claro, comercial y accionable. Nunca muestres UUIDs, nombres de tablas ni códigos técnicos internos.',
      '2. Basa tus recomendaciones únicamente en la información real del negocio; nunca inventes precios, stock, márgenes, métricas ni tendencias virales.',
      '3. No conviertas todo en anuncios de venta directa: equilibra contenido comercial, educativo, informativo y de marca.',
      '4. Nunca promociones productos agotados salvo que el propietario solicite explícitamente preventa o próximo ingreso.',
      '5. Si el usuario pide ideas, estrategias, carruseles, composiciones visuales o guiones audiovisuales, entrégalos estructurados, originales y listos para pasar a Producción o TryPost.',
      '6. Respeta siempre las aprobaciones y límites operativos: nunca afirmes que publicaste algo sin confirmación real.',
      '',
      'Contexto actual del workspace:',
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

    let reply = '';
    try {
      const turn = await this.ai.converse(
        { workspaceId, feature: AiFeature.SalesAgent, agentKey: 'social' },
        {
          system,
          messages,
          tools: [],
          maxOutputTokens: MAX_SUPERVISOR_OUTPUT_TOKENS,
        },
        { onTextDelta: () => undefined },
      );
      reply = turn.content
        .filter((b) => b.type === AiContentBlockType.Text)
        .map((b) => ('text' in b ? b.text : ''))
        .join('')
        .trim();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Social Supervisor AI call fallback: ${msg}`);
      reply = [
        `No hay un proveedor de IA disponible para responder en este momento (${msg}).`,
        opportunities.opportunities.length > 0
          ? `\nMientras configuras un proveedor de IA, detecté ${opportunities.opportunities.length} oportunidad(es) real(es) en tu catálogo:\n${opportunities.opportunities.map((o) => `- **${o.title}**: ${o.rationale}`).join('\n')}`
          : '',
      ].join('\n');
    }

    await this.prisma.socialAgentEvent.create({
      data: {
        workspaceId,
        eventType: 'supervisor_chat',
        summary: `Consulta al Supervisor de Agente Social: "${input.message.trim().slice(0, 70)}"`,
        severity: 'info',
      },
    });

    return { reply, opportunitiesUsed: opportunities.opportunities.length };
  }
}
