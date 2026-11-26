import { BadRequestException, Injectable } from '@nestjs/common';
import {
  AiConfigStatus,
  type Prisma,
  PrismaService,
  SalesAgentMode,
  type WorkspaceAgentConfig,
} from '@crossmart/database';
import type { Actor } from '../activity/entities/actor.js';
import { ActivityAction } from '../activity/enums/activity-action.enum.js';
import { ActivitySubjectType } from '../activity/enums/activity-subject-type.enum.js';
import { ActivityRecorder } from '../activity/services/activity-recorder.js';

export const INTERNAL_AGENT_KEYS = ['crossmart', 'sales'] as const;
export type InternalAgentKey = (typeof INTERNAL_AGENT_KEYS)[number];

export interface SalesCommercialPolicy {
  businessName?: string | null;
  tone?: string | null;
  paymentNotes?: string | null;
  deliveryNotes?: string | null;
  warrantyNotes?: string | null;
  handoffNotes?: string | null;
  channelConnectionId?: string | null;
}

export interface AgentConfigView {
  agentKey: InternalAgentKey;
  aiConnectionId: string | null;
  model: string | null;
  chatwootConnectionId: string | null;
  authorizedInboxIds: number[];
  commercialPolicy: SalesCommercialPolicy;
  salesMode: SalesAgentMode;
  updatedAt: Date | null;
}

export interface UpdateAgentConfigInput {
  aiConnectionId?: string | null;
  model?: string | null;
  chatwootConnectionId?: string | null;
  authorizedInboxIds?: number[];
  commercialPolicy?: SalesCommercialPolicy;
  salesMode?: SalesAgentMode;
}

function isInternalAgentKey(key: string): key is InternalAgentKey {
  return key === 'crossmart' || key === 'sales';
}

function parseInboxIds(raw: Prisma.JsonValue | null | undefined): number[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((item): item is number => typeof item === 'number' && item > 0))];
}

function parsePolicy(raw: Prisma.JsonValue | null | undefined): SalesCommercialPolicy {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;
  const opt = (key: string): string | null =>
    typeof obj[key] === 'string' && obj[key].trim().length > 0 ? obj[key].trim() : null;
  return {
    businessName: opt('businessName'),
    tone: opt('tone'),
    paymentNotes: opt('paymentNotes'),
    deliveryNotes: opt('deliveryNotes'),
    warrantyNotes: opt('warrantyNotes'),
    handoffNotes: opt('handoffNotes'),
    channelConnectionId: opt('channelConnectionId'),
  };
}

function toView(agentKey: InternalAgentKey, row: WorkspaceAgentConfig | null): AgentConfigView {
  return {
    agentKey,
    aiConnectionId: row?.aiConnectionId ?? null,
    model: row?.model ?? null,
    chatwootConnectionId: row?.chatwootConnectionId ?? null,
    authorizedInboxIds: parseInboxIds(row?.authorizedInboxIds),
    commercialPolicy: parsePolicy(row?.commercialPolicy),
    salesMode: row?.salesMode ?? SalesAgentMode.DISABLED,
    updatedAt: row?.updatedAt ?? null,
  };
}

/**
 * Single source of truth for internal agent AI assignments (`crossmart`, `sales`)
 * and Sales Agent commercial & Chatwoot operational controls.
 */
@Injectable()
export class AgentConfigsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityRecorder,
  ) {}

  async list(workspaceId: string): Promise<AgentConfigView[]> {
    const rows = await this.prisma.workspaceAgentConfig.findMany({ where: { workspaceId } });
    const byKey = new Map(rows.map((row) => [row.agentKey, row]));
    return INTERNAL_AGENT_KEYS.map((key) => toView(key, byKey.get(key) ?? null));
  }

  async get(workspaceId: string, agentKey: string): Promise<AgentConfigView> {
    if (!isInternalAgentKey(agentKey)) {
      throw new BadRequestException(`Unknown internal agent: ${agentKey}`);
    }
    const row = await this.prisma.workspaceAgentConfig.findUnique({
      where: { workspaceId_agentKey: { workspaceId, agentKey } },
    });
    return toView(agentKey, row);
  }

  async update(
    workspaceId: string,
    agentKey: string,
    input: UpdateAgentConfigInput,
    actor: Actor,
  ): Promise<AgentConfigView> {
    if (!isInternalAgentKey(agentKey)) {
      throw new BadRequestException(`Unknown internal agent: ${agentKey}`);
    }
    if (input.aiConnectionId) {
      const aiConn = await this.prisma.aiConnection.findFirst({
        where: { id: input.aiConnectionId, workspaceId },
      });
      if (!aiConn) throw new BadRequestException('Selected AI connection does not exist.');
      if (aiConn.status === AiConfigStatus.DISABLED) {
        throw new BadRequestException('Selected AI connection is disabled.');
      }
    }
    if (input.chatwootConnectionId) {
      const cwConn = await this.prisma.chatwootConnection.findFirst({
        where: { id: input.chatwootConnectionId, workspaceId },
      });
      if (!cwConn) throw new BadRequestException('Selected Chatwoot connection does not exist.');
    }

    const existing = await this.prisma.workspaceAgentConfig.findUnique({
      where: { workspaceId_agentKey: { workspaceId, agentKey } },
    });

    const nextAiConnectionId =
      input.aiConnectionId !== undefined
        ? input.aiConnectionId
        : (existing?.aiConnectionId ?? null);
    const nextModel =
      input.model !== undefined ? input.model?.trim() || null : (existing?.model ?? null);
    const nextChatwootId =
      agentKey === 'sales'
        ? input.chatwootConnectionId !== undefined
          ? input.chatwootConnectionId
          : (existing?.chatwootConnectionId ?? null)
        : null;
    const nextInboxes =
      agentKey === 'sales'
        ? (input.authorizedInboxIds ?? parseInboxIds(existing?.authorizedInboxIds))
        : [];
    const nextPolicy =
      agentKey === 'sales'
        ? { ...parsePolicy(existing?.commercialPolicy), ...input.commercialPolicy }
        : {};
    const nextMode =
      agentKey === 'sales'
        ? (input.salesMode ?? existing?.salesMode ?? SalesAgentMode.DISABLED)
        : SalesAgentMode.DISABLED;

    const saved = await this.prisma.workspaceAgentConfig.upsert({
      where: { workspaceId_agentKey: { workspaceId, agentKey } },
      create: {
        workspaceId,
        agentKey,
        aiConnectionId: nextAiConnectionId,
        model: nextModel,
        chatwootConnectionId: nextChatwootId,
        authorizedInboxIds: nextInboxes as unknown as Prisma.InputJsonValue,
        commercialPolicy: nextPolicy as unknown as Prisma.InputJsonValue,
        salesMode: nextMode,
        updatedById: actor.userId,
      },
      update: {
        aiConnectionId: nextAiConnectionId,
        model: nextModel,
        chatwootConnectionId: nextChatwootId,
        authorizedInboxIds: nextInboxes as unknown as Prisma.InputJsonValue,
        commercialPolicy: nextPolicy as unknown as Prisma.InputJsonValue,
        salesMode: nextMode,
        updatedById: actor.userId,
      },
    });

    await this.activity.record(workspaceId, actor, {
      action: ActivityAction.AiConfigUpdated,
      subject: {
        type: ActivitySubjectType.Workspace,
        id: workspaceId,
        label: agentKey === 'sales' ? 'Sales Agent' : 'Crossmart Agent',
      },
      detail: nextModel ?? undefined,
    });
    return toView(agentKey, saved);
  }

  /** Immediately switches the Sales Agent to DISABLED so even queued work stops sending. */
  async stopSalesAgent(workspaceId: string, actor: Actor): Promise<AgentConfigView> {
    return this.update(workspaceId, 'sales', { salesMode: SalesAgentMode.DISABLED }, actor);
  }
}
