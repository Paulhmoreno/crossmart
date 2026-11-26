import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  type Prisma,
  PrismaService,
  type SalesEvent,
  type SalesKnowledgeEntry,
  SalesKnowledgeStatus,
  type SalesLearningProposal,
  SalesLearningStatus,
} from '@crossmart/database';

const MAX_EVENT_SUMMARY_CHARS = 240;
const DEFAULT_EVENTS_LIMIT = 60;
const MAX_EVENTS_LIMIT = 150;

export const SALES_KNOWLEDGE_CATEGORIES = [
  'business_info',
  'location_hours',
  'delivery_coverage',
  'payment_methods',
  'warranties',
  'discounts',
  'channel_policies',
  'service_style',
  'faq',
] as const;

export type SalesKnowledgeCategory = (typeof SALES_KNOWLEDGE_CATEGORIES)[number];

export const SALES_EVENT_TYPES = [
  'message_received',
  'product_identified',
  'catalog_queried',
  'reply_sent',
  'handoff_triggered',
  'communication_error',
  'learning_proposed',
  'knowledge_changed',
  'config_changed',
] as const;

export type SalesEventType = (typeof SALES_EVENT_TYPES)[number];

export interface SalesKnowledgeEntryView {
  id: string;
  category: string;
  scope: string;
  title: string;
  content: string;
  status: SalesKnowledgeStatus;
  source: string;
  version: number;
  approvedAt: Date;
  updatedAt: Date;
}

export interface SalesLearningProposalView {
  id: string;
  category: string;
  scope: string;
  title: string;
  proposedContent: string;
  rationale: string | null;
  originType: string;
  originConversationId: string | null;
  originMessageId: string | null;
  targetEntryId: string | null;
  status: SalesLearningStatus;
  reviewedAt: Date | null;
  createdAt: Date;
}

export interface SalesEventView {
  id: string;
  type: string;
  channelType: string | null;
  conversationId: string | null;
  summary: string;
  details: Record<string, unknown>;
  createdAt: Date;
}

export interface CreateKnowledgeProposalInput {
  category: string;
  scope?: string | null;
  title: string;
  proposedContent: string;
  rationale?: string | null;
  originType?: 'supervisor_chat' | 'simulation_feedback' | 'conversation_review';
  originConversationId?: string | null;
  originMessageId?: string | null;
  targetEntryId?: string | null;
}

export interface ApproveKnowledgeProposalInput {
  category?: string;
  scope?: string;
  title?: string;
  content?: string;
}

export function normalizeKnowledgeCategory(raw: string | undefined | null): SalesKnowledgeCategory {
  const cleaned = (raw ?? '').trim().toLowerCase();
  if ((SALES_KNOWLEDGE_CATEGORIES as readonly string[]).includes(cleaned)) {
    return cleaned as SalesKnowledgeCategory;
  }
  return 'business_info';
}

export function normalizeChannelSlug(raw: string | undefined | null): string {
  const lower = (raw ?? '').trim().toLowerCase();
  if (!lower || lower === 'global' || lower === 'all') return 'global';
  if (lower.includes('webwidget') || lower.includes('web_widget') || lower === 'web') {
    return 'web_widget';
  }
  if (lower.includes('whatsapp')) return 'whatsapp';
  if (lower.includes('marketplace')) return 'marketplace';
  if (lower.includes('facebook') || lower.includes('messenger')) return 'messenger';
  if (lower.includes('instagram')) return 'instagram';
  if (lower.includes('telegram')) return 'telegram';
  return lower.replace(/^channel::/, '').replace(/[^a-z0-9_]+/g, '_');
}

export function normalizeKnowledgeScope(raw: string | undefined | null): string {
  const cleaned = (raw ?? '').trim().toLowerCase();
  if (!cleaned || cleaned === 'global' || cleaned === 'all') return 'global';
  const slug = cleaned.startsWith('channel:')
    ? normalizeChannelSlug(cleaned.slice('channel:'.length))
    : normalizeChannelSlug(cleaned);
  return slug === 'global' ? 'global' : `channel:${slug}`;
}

function toEntryView(row: SalesKnowledgeEntry): SalesKnowledgeEntryView {
  return {
    id: row.id,
    category: row.category,
    scope: row.scope,
    title: row.title,
    content: row.content,
    status: row.status,
    source: row.source,
    version: row.version,
    approvedAt: row.approvedAt,
    updatedAt: row.updatedAt,
  };
}

function toProposalView(row: SalesLearningProposal): SalesLearningProposalView {
  return {
    id: row.id,
    category: row.category,
    scope: row.scope,
    title: row.title,
    proposedContent: row.proposedContent,
    rationale: row.rationale,
    originType: row.originType,
    originConversationId: row.originConversationId,
    originMessageId: row.originMessageId,
    targetEntryId: row.targetEntryId,
    status: row.status,
    reviewedAt: row.reviewedAt,
    createdAt: row.createdAt,
  };
}

function toEventView(row: SalesEvent): SalesEventView {
  return {
    id: row.id,
    type: row.type,
    channelType: row.channelType,
    conversationId: row.conversationId,
    summary: row.summary,
    details: (row.details as Record<string, unknown>) ?? {},
    createdAt: row.createdAt,
  };
}

/**
 * Provider-independent commercial knowledge base, supervised learning workflow
 * (observation -> proposal -> human review -> approved versioned knowledge),
 * and real Sales Agent event ledger.
 */
@Injectable()
export class SalesKnowledgeService {
  private readonly migratedWorkspaces = new Set<string>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Safe, idempotent migration of legacy `workspace_agent_configs.commercial_policy` fields
   * into `sales_knowledge_entries` (global scope). Detects duplicates and contradictions:
   * - Identical active entry -> skipped
   * - Conflicting active entry in same category -> creates PENDING learning proposal for review
   * - Otherwise -> creates ACTIVE versioned entry with `source: 'legacy_policy_migration'`
   */
  async ensureLegacyPolicyMigrated(workspaceId: string): Promise<void> {
    if (this.migratedWorkspaces.has(workspaceId)) return;
    const cfg = await this.prisma.workspaceAgentConfig.findUnique({
      where: { workspaceId_agentKey: { workspaceId, agentKey: 'sales' } },
      select: { commercialPolicy: true, updatedById: true },
    });
    const raw = cfg?.commercialPolicy;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      this.migratedWorkspaces.add(workspaceId);
      return;
    }
    const obj = raw as Record<string, unknown>;
    const mappings: Array<{ key: string; category: SalesKnowledgeCategory; title: string }> = [
      { key: 'businessName', category: 'business_info', title: 'Nombre comercial del negocio' },
      { key: 'paymentNotes', category: 'payment_methods', title: 'Formas y condiciones de pago' },
      {
        key: 'deliveryNotes',
        category: 'delivery_coverage',
        title: 'Condiciones de envío y entrega',
      },
      { key: 'warrantyNotes', category: 'warranties', title: 'Garantías y devoluciones' },
      { key: 'tone', category: 'service_style', title: 'Estilo de atención comercial' },
    ];

    const existingEntries = await this.prisma.salesKnowledgeEntry.findMany({
      where: { workspaceId, status: SalesKnowledgeStatus.ACTIVE, scope: 'global' },
    });
    const existingProposals = await this.prisma.salesLearningProposal.findMany({
      where: { workspaceId, originType: 'legacy_policy_migration' },
    });

    for (const item of mappings) {
      const rawVal = obj[item.key];
      const value = typeof rawVal === 'string' ? rawVal.trim() : '';
      if (!value) continue;
      const sameCategory = existingEntries.filter((entry) => entry.category === item.category);
      const alreadyMigrated = sameCategory.some(
        (entry) =>
          entry.source === 'legacy_policy_migration' ||
          entry.content.trim().toLowerCase() === value.toLowerCase(),
      );
      if (alreadyMigrated) continue;

      if (sameCategory.length > 0) {
        const alreadyProposed = existingProposals.some(
          (prop) =>
            prop.category === item.category &&
            prop.proposedContent.trim().toLowerCase() === value.toLowerCase(),
        );
        if (!alreadyProposed) {
          await this.createProposal(workspaceId, {
            category: item.category,
            scope: 'global',
            title: item.title,
            proposedContent: value,
            rationale:
              'Valor previo detectado en configuración; requiere revisión por posible conflicto.',
            originType: 'conversation_review',
          });
        }
        continue;
      }

      const created = await this.prisma.salesKnowledgeEntry.create({
        data: {
          workspaceId,
          category: item.category,
          scope: 'global',
          title: item.title,
          content: value,
          source: 'legacy_policy_migration',
          approvedById: cfg.updatedById,
        },
      });
      existingEntries.push(created);
    }

    this.migratedWorkspaces.add(workspaceId);
  }

  async listEntries(workspaceId: string): Promise<SalesKnowledgeEntryView[]> {
    await this.ensureLegacyPolicyMigrated(workspaceId);
    const rows = await this.prisma.salesKnowledgeEntry.findMany({
      where: { workspaceId, status: SalesKnowledgeStatus.ACTIVE },
      orderBy: [{ scope: 'asc' }, { category: 'asc' }, { updatedAt: 'desc' }],
    });
    return rows.map(toEntryView);
  }

  async updateEntry(
    workspaceId: string,
    entryId: string,
    input: { category?: string; scope?: string; title?: string; content?: string },
    userId: string | null,
  ): Promise<SalesKnowledgeEntryView> {
    const existing = await this.prisma.salesKnowledgeEntry.findFirst({
      where: { id: entryId, workspaceId },
    });
    if (!existing) throw new NotFoundException('Commercial knowledge entry not found.');
    const updated = await this.prisma.salesKnowledgeEntry.update({
      where: { id: entryId },
      data: {
        category: input.category ? normalizeKnowledgeCategory(input.category) : existing.category,
        scope: input.scope ? normalizeKnowledgeScope(input.scope) : existing.scope,
        title: input.title?.trim() || existing.title,
        content: input.content?.trim() || existing.content,
        version: existing.version + 1,
        approvedById: userId,
        approvedAt: new Date(),
      },
    });
    await this.recordEvent(workspaceId, {
      type: 'knowledge_changed',
      summary: `Knowledge updated: ${updated.title} (v${updated.version})`,
      details: { entryId: updated.id, category: updated.category, scope: updated.scope },
    });
    return toEntryView(updated);
  }

  async archiveEntry(workspaceId: string, entryId: string): Promise<void> {
    const existing = await this.prisma.salesKnowledgeEntry.findFirst({
      where: { id: entryId, workspaceId },
    });
    if (!existing) throw new NotFoundException('Commercial knowledge entry not found.');
    await this.prisma.salesKnowledgeEntry.update({
      where: { id: entryId },
      data: { status: SalesKnowledgeStatus.ARCHIVED },
    });
    await this.recordEvent(workspaceId, {
      type: 'knowledge_changed',
      summary: `Knowledge archived: ${existing.title}`,
      details: { entryId: existing.id, category: existing.category, scope: existing.scope },
    });
  }

  async listProposals(workspaceId: string): Promise<SalesLearningProposalView[]> {
    const rows = await this.prisma.salesLearningProposal.findMany({
      where: { workspaceId },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 50,
    });
    return rows.map(toProposalView);
  }

  async createProposal(
    workspaceId: string,
    input: CreateKnowledgeProposalInput,
  ): Promise<SalesLearningProposalView> {
    const title = input.title.trim();
    const proposedContent = input.proposedContent.trim();
    if (!title || !proposedContent) {
      throw new BadRequestException('Title and proposed content are required.');
    }
    const category = normalizeKnowledgeCategory(input.category);
    const scope = normalizeKnowledgeScope(input.scope);
    const created = await this.prisma.salesLearningProposal.create({
      data: {
        workspaceId,
        category,
        scope,
        title,
        proposedContent,
        rationale: input.rationale?.trim() || null,
        originType: input.originType ?? 'supervisor_chat',
        originConversationId: input.originConversationId ?? null,
        originMessageId: input.originMessageId ?? null,
        targetEntryId: input.targetEntryId ?? null,
        status: SalesLearningStatus.PENDING,
      },
    });
    await this.recordEvent(workspaceId, {
      type: 'learning_proposed',
      conversationId: input.originConversationId ?? null,
      summary: `Learning proposed: ${created.title} (${created.scope})`,
      details: { proposalId: created.id, category: created.category, scope: created.scope },
    });
    return toProposalView(created);
  }

  async approveProposal(
    workspaceId: string,
    proposalId: string,
    userId: string | null,
    edits?: ApproveKnowledgeProposalInput,
  ): Promise<{ proposal: SalesLearningProposalView; entry: SalesKnowledgeEntryView }> {
    const proposal = await this.prisma.salesLearningProposal.findFirst({
      where: { id: proposalId, workspaceId },
    });
    if (!proposal) throw new NotFoundException('Learning proposal not found.');
    if (proposal.status !== SalesLearningStatus.PENDING) {
      throw new BadRequestException('Only pending proposals can be approved.');
    }

    const category = normalizeKnowledgeCategory(edits?.category ?? proposal.category);
    const scope = normalizeKnowledgeScope(edits?.scope ?? proposal.scope);
    const title = (edits?.title ?? proposal.title).trim();
    const content = (edits?.content ?? proposal.proposedContent).trim();
    if (!title || !content) {
      throw new BadRequestException('Title and content cannot be empty.');
    }

    let entry: SalesKnowledgeEntry;
    if (proposal.targetEntryId) {
      const existing = await this.prisma.salesKnowledgeEntry.findFirst({
        where: { id: proposal.targetEntryId, workspaceId },
      });
      if (existing) {
        entry = await this.prisma.salesKnowledgeEntry.update({
          where: { id: existing.id },
          data: {
            category,
            scope,
            title,
            content,
            status: SalesKnowledgeStatus.ACTIVE,
            version: existing.version + 1,
            source: 'learning_proposal',
            approvedById: userId,
            approvedAt: new Date(),
          },
        });
      } else {
        entry = await this.prisma.salesKnowledgeEntry.create({
          data: {
            workspaceId,
            category,
            scope,
            title,
            content,
            source: 'learning_proposal',
            approvedById: userId,
            approvedAt: new Date(),
          },
        });
      }
    } else {
      entry = await this.prisma.salesKnowledgeEntry.create({
        data: {
          workspaceId,
          category,
          scope,
          title,
          content,
          source: 'learning_proposal',
          approvedById: userId,
          approvedAt: new Date(),
        },
      });
    }

    const updatedProposal = await this.prisma.salesLearningProposal.update({
      where: { id: proposal.id },
      data: {
        category,
        scope,
        title,
        proposedContent: content,
        targetEntryId: entry.id,
        status: SalesLearningStatus.APPROVED,
        reviewedById: userId,
        reviewedAt: new Date(),
      },
    });

    await this.recordEvent(workspaceId, {
      type: 'knowledge_changed',
      conversationId: proposal.originConversationId,
      summary: `Knowledge approved: ${entry.title} (${entry.scope}, v${entry.version})`,
      details: {
        entryId: entry.id,
        proposalId: proposal.id,
        category: entry.category,
        scope: entry.scope,
      },
    });

    return { proposal: toProposalView(updatedProposal), entry: toEntryView(entry) };
  }

  async rejectProposal(
    workspaceId: string,
    proposalId: string,
    userId: string | null,
  ): Promise<SalesLearningProposalView> {
    const proposal = await this.prisma.salesLearningProposal.findFirst({
      where: { id: proposalId, workspaceId },
    });
    if (!proposal) throw new NotFoundException('Learning proposal not found.');
    if (proposal.status !== SalesLearningStatus.PENDING) {
      throw new BadRequestException('Only pending proposals can be rejected.');
    }
    const updated = await this.prisma.salesLearningProposal.update({
      where: { id: proposal.id },
      data: {
        status: SalesLearningStatus.REJECTED,
        reviewedById: userId,
        reviewedAt: new Date(),
      },
    });
    return toProposalView(updated);
  }

  /**
   * Returns active approved knowledge applicable to a given channel (always includes `global`,
   * plus entries scoped to `channel:<slug>` when a channel is active).
   */
  async getApplicableKnowledge(
    workspaceId: string,
    channelType?: string | null,
  ): Promise<SalesKnowledgeEntryView[]> {
    await this.ensureLegacyPolicyMigrated(workspaceId);
    const slug = normalizeChannelSlug(channelType);
    const scopes = slug === 'global' ? ['global'] : ['global', `channel:${slug}`];
    const rows = await this.prisma.salesKnowledgeEntry.findMany({
      where: {
        workspaceId,
        status: SalesKnowledgeStatus.ACTIVE,
        scope: { in: scopes },
      },
      orderBy: [{ scope: 'asc' }, { category: 'asc' }, { updatedAt: 'desc' }],
    });
    return rows.map(toEntryView);
  }

  async recordEvent(
    workspaceId: string,
    event: {
      type: SalesEventType;
      channelType?: string | null;
      conversationId?: string | null;
      summary: string;
      details?: Record<string, unknown>;
    },
  ): Promise<SalesEventView> {
    const row = await this.prisma.salesEvent.create({
      data: {
        workspaceId,
        type: event.type,
        channelType: event.channelType ?? null,
        conversationId: event.conversationId ?? null,
        summary: event.summary.slice(0, MAX_EVENT_SUMMARY_CHARS),
        details: (event.details ?? {}) as unknown as Prisma.InputJsonValue,
      },
    });
    return toEventView(row);
  }

  async listEvents(workspaceId: string, limit = DEFAULT_EVENTS_LIMIT): Promise<SalesEventView[]> {
    const rows = await this.prisma.salesEvent.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), MAX_EVENTS_LIMIT),
    });
    return rows.map(toEventView);
  }
}
