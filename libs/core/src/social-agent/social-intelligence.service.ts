import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { type Prisma, PrismaService } from '@crossmart/database';
import type { Actor } from '../activity/entities/actor.js';
import { assertPublicContentSafe } from '../ai/rules/public-content-guard.js';
import { TryPostClient } from './trypost.client.js';
import { TryPostConnectionService } from './trypost-connection.service.js';

export interface CommercialOpportunity {
  type: 'HIGH_STOCK' | 'HIGH_MARGIN' | 'NEW_ARRIVAL' | 'EDUCATIONAL' | 'CATEGORY_SPOTLIGHT';
  title: string;
  rationale: string;
  productId?: string;
  sku?: string | null;
  price?: number | null;
  availableStock?: number | null;
  verifiableMarginPct?: number | null;
  suggestedPillar: 'commercial' | 'educational' | 'informative' | 'brand';
}

export interface VisualCompositionInput {
  headline: string;
  subheadline?: string;
  priceLabel?: string | null;
  ctaLabel?: string;
  aspectRatio: '1:1' | '4:5' | '9:16' | '16:9';
  backgroundHex?: string;
  accentHex?: string;
  textHex?: string;
}

const ASPECT_DIMENSIONS: Record<VisualCompositionInput['aspectRatio'], { width: number; height: number }> = {
  '1:1': { width: 1080, height: 1080 },
  '4:5': { width: 1080, height: 1350 },
  '9:16': { width: 1080, height: 1920 },
  '16:9': { width: 1920, height: 1080 },
};

function escapeXml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 100% universal, multi-tenant commercial opportunity detector, deterministic budget & approval
 * gatekeeper, lightweight SVG visual composer, and audiovisual production coordinator.
 * Contains ZERO hardcoded company names, characters, products, or industry presets.
 */
@Injectable()
export class SocialIntelligenceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly trypostConnections: TryPostConnectionService,
    private readonly trypostClient: TryPostClient,
  ) {}

  async getOrCreatePolicy(workspaceId: string) {
    const existing = await this.prisma.socialBudgetPolicy.findUnique({ where: { workspaceId } });
    if (existing) return existing;
    return this.prisma.socialBudgetPolicy.create({
      data: {
        workspaceId,
        autonomyMode: 'SUPERVISED',
        paused: false,
        autoPublishAuthorized: false,
        monthlyLimitUsd: 0,
        perTaskLimitUsd: 0,
        maxRegenerationsPerItem: 3,
      },
    });
  }

  async updatePolicy(
    workspaceId: string,
    patch: {
      autonomyMode?: string;
      paused?: boolean;
      autoPublishAuthorized?: boolean;
      monthlyLimitUsd?: number;
      perTaskLimitUsd?: number;
      maxRegenerationsPerItem?: number;
      authorizedChannelIds?: string[];
      planningFrequency?: string;
      timezone?: string;
    },
  ) {
    await this.getOrCreatePolicy(workspaceId);
    const updated = await this.prisma.socialBudgetPolicy.update({
      where: { workspaceId },
      data: {
        ...(patch.autonomyMode ? { autonomyMode: patch.autonomyMode } : {}),
        ...(typeof patch.paused === 'boolean' ? { paused: patch.paused } : {}),
        ...(typeof patch.autoPublishAuthorized === 'boolean'
          ? { autoPublishAuthorized: patch.autoPublishAuthorized }
          : {}),
        ...(typeof patch.monthlyLimitUsd === 'number'
          ? { monthlyLimitUsd: Math.max(0, patch.monthlyLimitUsd) }
          : {}),
        ...(typeof patch.perTaskLimitUsd === 'number'
          ? { perTaskLimitUsd: Math.max(0, patch.perTaskLimitUsd) }
          : {}),
        ...(typeof patch.maxRegenerationsPerItem === 'number'
          ? { maxRegenerationsPerItem: Math.max(1, Math.min(20, patch.maxRegenerationsPerItem)) }
          : {}),
        ...(patch.authorizedChannelIds
          ? { authorizedChannelIds: patch.authorizedChannelIds as unknown as Prisma.InputJsonValue }
          : {}),
        ...(patch.planningFrequency ? { planningFrequency: patch.planningFrequency } : {}),
        ...(patch.timezone ? { timezone: patch.timezone } : {}),
      },
    });

    await this.prisma.socialAgentEvent.create({
      data: {
        workspaceId,
        eventType: 'policy_updated',
        summary: `Política operativa actualizada (modo: ${updated.autonomyMode}, pausado: ${updated.paused ? 'sí' : 'no'}).`,
        severity: 'info',
      },
    });
    return updated;
  }

  /**
   * Analyzes the FULL workspace catalog using real aggregate counts (never truncating at 100)
   * and selects commercially reasoned candidates without exposing internal costs/margins in
   * public-facing rationales. Excludes out-of-stock products from automatic promotion and avoids
   * over-prioritizing single-unit items.
   */
  async analyzeBusinessOpportunities(workspaceId: string): Promise<{
    totalProducts: number;
    inStockProducts: number;
    eligibleProducts: number;
    analyzedSample: number;
    topCategories: string[];
    opportunities: CommercialOpportunity[];
  }> {
    const [totalProducts, inStockProducts, eligibleProducts, categoryGroups, candidates] =
      await Promise.all([
        this.prisma.product.count({ where: { workspaceId } }),
        this.prisma.product.count({
          where: {
            workspaceId,
            variants: { some: { inventoryItem: { available: { gt: 0 } } } },
          },
        }),
        this.prisma.product.count({
          where: {
            workspaceId,
            variants: { some: { inventoryItem: { available: { gte: 2 } } } },
          },
        }),
        this.prisma.product.groupBy({
          by: ['productType'],
          where: {
            workspaceId,
            productType: { not: null },
            variants: { some: { inventoryItem: { available: { gt: 0 } } } },
          },
          _count: { _all: true },
          orderBy: { _count: { productType: 'desc' } },
          take: 8,
        }),
        this.prisma.product.findMany({
          where: {
            workspaceId,
            variants: { some: { inventoryItem: { available: { gt: 0 } } } },
          },
          include: {
            variants: {
              include: { inventoryItem: true },
            },
            media: {
              orderBy: { position: 'asc' },
              take: 1,
              select: { url: true },
            },
          },
          orderBy: { updatedAt: 'desc' },
          take: 120,
        }),
      ]);

    const topCategories = categoryGroups
      .map((g) => g.productType)
      .filter((c): c is string => Boolean(c && c.trim()));

    const scored = candidates
      .map((prod) => {
        const totalAvailable = prod.variants.reduce(
          (sum, v) => sum + (v.inventoryItem?.available ?? 0),
          0,
        );
        const primary = prod.variants[0];
        const price = primary ? Number(primary.price) : null;
        const hasImage = prod.media.length > 0;
        // Prefer products with >= 2 units in stock and real photography to avoid wasting
        // creative effort on single-unit items.
        const score =
          (totalAvailable >= 5 ? 30 : totalAvailable >= 2 ? 15 : 2) +
          (hasImage ? 20 : 0) +
          (price && price > 0 ? 10 : 0);
        return { prod, totalAvailable, primary, price, hasImage, score };
      })
      .filter((entry) => entry.totalAvailable > 0)
      .sort((a, b) => b.score - a.score || b.totalAvailable - a.totalAvailable);

    const opportunities: CommercialOpportunity[] = [];
    for (const entry of scored) {
      if (opportunities.length >= 6) break;
      if (entry.totalAvailable < 2 && eligibleProducts >= 3) continue;
      opportunities.push({
        type: entry.totalAvailable >= 5 ? 'HIGH_STOCK' : 'CATEGORY_SPOTLIGHT',
        title: `Destacar en catálogo: ${entry.prod.title}`,
        rationale: `Disponibilidad verificada de ${entry.totalAvailable} unidad(es)${
          entry.price ? ` · precio público $${entry.price.toFixed(2)}` : ''
        }${entry.hasImage ? ' · cuenta con fotografía real en catálogo' : ''}.`,
        productId: entry.prod.id,
        sku: entry.primary?.sku ?? null,
        price: entry.price,
        availableStock: entry.totalAvailable,
        // Never expose internal margin percentage into public-copy opportunities
        verifiableMarginPct: null,
        suggestedPillar: 'commercial',
      });
    }

    if (topCategories.length > 0) {
      opportunities.push({
        type: 'EDUCATIONAL',
        title: `Guía práctica para elegir en ${topCategories[0]}`,
        rationale: `Categoría principal con stock verificado (${topCategories[0]}); contenido educativo fortalece autoridad sin depender únicamente de venta directa.`,
        suggestedPillar: 'educational',
      });
    } else if (totalProducts > 0) {
      opportunities.push({
        type: 'EDUCATIONAL',
        title: 'Contenido educativo sobre cómo elegir y aprovechar el catálogo',
        rationale: 'Equilibra el calendario editorial con valor informativo y preguntas frecuentes de clientes.',
        suggestedPillar: 'educational',
      });
    }

    return {
      totalProducts,
      inStockProducts,
      eligibleProducts,
      analyzedSample: candidates.length,
      topCategories,
      opportunities,
    };
  }

  /**
   * Generates a lightweight, deterministic, social-ready SVG visual composition using verified data.
   */
  generateSvgComposition(input: VisualCompositionInput): {
    svg: string;
    width: number;
    height: number;
    aspectRatio: string;
  } {
    const { width, height } = ASPECT_DIMENSIONS[input.aspectRatio] ?? ASPECT_DIMENSIONS['1:1'];
    const bg = input.backgroundHex || '#0f172a';
    const accent = input.accentHex || '#2563eb';
    const text = input.textHex || '#f8fafc';
    const safeX = Math.round(width * 0.08);
    const headlineY = Math.round(height * 0.42);
    const subY = Math.round(height * 0.54);
    const priceY = Math.round(height * 0.68);
    const ctaY = Math.round(height * 0.82);

    const svg = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
      `<rect width="100%" height="100%" fill="${escapeXml(bg)}" />`,
      `<rect x="${safeX}" y="${Math.round(height * 0.1)}" width="${Math.round(width * 0.14)}" height="12" rx="6" fill="${escapeXml(accent)}" />`,
      `<text x="${safeX}" y="${headlineY}" fill="${escapeXml(text)}" font-family="system-ui, -apple-system, sans-serif" font-size="${Math.round(width * 0.062)}" font-weight="700">${escapeXml(input.headline.slice(0, 70))}</text>`,
      input.subheadline
        ? `<text x="${safeX}" y="${subY}" fill="${escapeXml(text)}" fill-opacity="0.82" font-family="system-ui, -apple-system, sans-serif" font-size="${Math.round(width * 0.034)}">${escapeXml(input.subheadline.slice(0, 95))}</text>`
        : '',
      input.priceLabel
        ? `<text x="${safeX}" y="${priceY}" fill="${escapeXml(accent)}" font-family="system-ui, -apple-system, sans-serif" font-size="${Math.round(width * 0.055)}" font-weight="700">${escapeXml(input.priceLabel)}</text>`
        : '',
      input.ctaLabel
        ? `<rect x="${safeX}" y="${ctaY - 46}" width="${Math.min(width - safeX * 2, 420)}" height="68" rx="12" fill="${escapeXml(accent)}" /><text x="${safeX + 28}" y="${ctaY}" fill="#ffffff" font-family="system-ui, -apple-system, sans-serif" font-size="${Math.round(width * 0.03)}" font-weight="600">${escapeXml(input.ctaLabel.slice(0, 40))}</text>`
        : '',
      `</svg>`,
    ]
      .filter(Boolean)
      .join('');

    return { svg, width, height, aspectRatio: input.aspectRatio };
  }

  /**
   * Deterministic budget check before executing any paid generative operation.
   */
  async assertBudgetAvailable(workspaceId: string, estimatedCostUsd: number): Promise<void> {
    if (estimatedCostUsd <= 0) return;
    const policy = await this.getOrCreatePolicy(workspaceId);
    if (policy.paused) {
      throw new ForbiddenException('Social Agent is currently paused.');
    }
    const perTask = Number(policy.perTaskLimitUsd);
    const monthly = Number(policy.monthlyLimitUsd);
    const spent = Number(policy.spentThisMonthUsd);
    if (perTask <= 0 || monthly <= 0) {
      throw new ForbiddenException(
        'Paid generative operations require an explicitly authorized creative budget limit.',
      );
    }
    if (estimatedCostUsd > perTask) {
      throw new ForbiddenException(
        `Estimated cost ($${estimatedCostUsd.toFixed(2)}) exceeds per-task limit ($${perTask.toFixed(2)}).`,
      );
    }
    if (spent + estimatedCostUsd > monthly) {
      throw new ForbiddenException(
        `Estimated cost would exceed monthly creative budget ($${monthly.toFixed(2)}).`,
      );
    }
  }

  // ─── Content Items, Creative Profiles & Approval Gatekeeper ─────────────────

  listContentItems(workspaceId: string, status?: string) {
    return this.prisma.socialContentItem.findMany({
      where: { workspaceId, ...(status ? { status } : {}) },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });
  }

  async createContentItem(
    workspaceId: string,
    input: {
      kind?: string;
      title: string;
      objective?: string;
      pillar?: string;
      caption?: string;
      productionMode?: string;
      productionSpec?: Record<string, unknown>;
      productIds?: string[];
      creativeProfileId?: string | null;
      targetChannelIds?: string[];
    },
  ) {
    assertPublicContentSafe(`${input.title}\n${input.caption ?? ''}`, 'content piece');
    const item = await this.prisma.socialContentItem.create({
      data: {
        workspaceId,
        kind: input.kind ?? 'POST',
        title: input.title.trim(),
        objective: input.objective?.trim() ?? null,
        pillar: input.pillar?.trim() ?? null,
        caption: input.caption ?? '',
        productionMode: input.productionMode ?? 'ASSISTED',
        productionSpec: (input.productionSpec ?? {}) as unknown as Prisma.InputJsonValue,
        productIds: (input.productIds ?? []) as unknown as Prisma.InputJsonValue,
        creativeProfileId: input.creativeProfileId ?? null,
        targetChannelIds: (input.targetChannelIds ?? []) as unknown as Prisma.InputJsonValue,
        status: input.kind === 'IDEA' ? 'IDEA' : 'PENDING_APPROVAL',
        contentVersion: 1,
      },
    });

    await this.prisma.socialAgentEvent.create({
      data: {
        workspaceId,
        eventType: 'content_created',
        summary: `Nueva pieza creada (${item.kind}): ${item.title}`,
        severity: 'info',
        metadata: { itemId: item.id, kind: item.kind },
      },
    });

    return item;
  }

  /**
   * Editing content increments `contentVersion`, automatically invalidating any prior approval
   * so modified content cannot be published under an outdated approval.
   */
  async updateContentItem(
    workspaceId: string,
    itemId: string,
    patch: {
      title?: string;
      caption?: string;
      objective?: string;
      productionSpec?: Record<string, unknown>;
      mediaAssets?: Array<Record<string, unknown>>;
      targetChannelIds?: string[];
    },
  ) {
    const existing = await this.prisma.socialContentItem.findFirst({
      where: { id: itemId, workspaceId },
    });
    if (!existing) throw new NotFoundException('Social content item not found.');
    assertPublicContentSafe(`${patch.title ?? ''}\n${patch.caption ?? ''}`, 'content piece');

    const contentChanged =
      patch.title !== undefined ||
      patch.caption !== undefined ||
      patch.mediaAssets !== undefined ||
      patch.productionSpec !== undefined;

    const nextVersion = contentChanged ? existing.contentVersion + 1 : existing.contentVersion;
    const nextStatus =
      contentChanged && existing.status === 'APPROVED' ? 'PENDING_APPROVAL' : existing.status;

    return this.prisma.socialContentItem.update({
      where: { id: existing.id },
      data: {
        ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
        ...(patch.caption !== undefined ? { caption: patch.caption } : {}),
        ...(patch.objective !== undefined ? { objective: patch.objective } : {}),
        ...(patch.productionSpec !== undefined
          ? { productionSpec: patch.productionSpec as unknown as Prisma.InputJsonValue }
          : {}),
        ...(patch.mediaAssets !== undefined
          ? { mediaAssets: patch.mediaAssets as unknown as Prisma.InputJsonValue }
          : {}),
        ...(patch.targetChannelIds !== undefined
          ? { targetChannelIds: patch.targetChannelIds as unknown as Prisma.InputJsonValue }
          : {}),
        contentVersion: nextVersion,
        status: nextStatus,
      },
    });
  }

  async approveContentItem(workspaceId: string, itemId: string, actor: Actor) {
    const item = await this.prisma.socialContentItem.findFirst({
      where: { id: itemId, workspaceId },
    });
    if (!item) throw new NotFoundException('Social content item not found.');
    assertPublicContentSafe(`${item.title}\n${item.caption ?? ''}`, 'TryPost content');

    const updated = await this.prisma.socialContentItem.update({
      where: { id: item.id },
      data: {
        status: 'APPROVED',
        approvedVersion: item.contentVersion,
        approvedAt: new Date(),
        approvedById: actor.userId ?? null,
      },
    });

    await this.prisma.socialAgentEvent.create({
      data: {
        workspaceId,
        eventType: 'content_approved',
        summary: `Contenido aprobado (v${item.contentVersion}): ${item.title}`,
        severity: 'success',
        metadata: { itemId: item.id, approvedVersion: item.contentVersion },
      },
    });
    return updated;
  }

  async rejectContentItem(workspaceId: string, itemId: string, reason?: string) {
    const item = await this.prisma.socialContentItem.findFirst({
      where: { id: itemId, workspaceId },
    });
    if (!item) throw new NotFoundException('Social content item not found.');

    const updated = await this.prisma.socialContentItem.update({
      where: { id: item.id },
      data: {
        status: 'REJECTED',
        approvedVersion: null,
      },
    });

    await this.prisma.socialAgentEvent.create({
      data: {
        workspaceId,
        eventType: 'content_rejected',
        summary: `Contenido rechazado: ${item.title}${reason ? ` (${reason})` : ''}`,
        severity: 'warning',
        metadata: { itemId: item.id, reason: reason ?? null },
      },
    });
    return updated;
  }

  /**
   * Sends an idea or draft to TryPost safely.
   * CRITICAL SECURITY GATE: Because TryPost admin API keys bypass TryPost's member approval queue,
   * scheduling (`mode === 'scheduled'`) is STRICTLY BLOCKED unless:
   *   1. `item.approvedVersion === item.contentVersion` (current version is approved), AND
   *   2. Workspace policy is not paused.
   * Creating ideas or remote drafts (`mode === 'idea' | 'draft'`) is always safe and non-publishing.
   */
  async pushToTryPost(
    workspaceId: string,
    itemId: string,
    options: { mode: 'idea' | 'draft' | 'scheduled'; channelIds?: string[]; scheduledAt?: string },
  ) {
    const item = await this.prisma.socialContentItem.findFirst({
      where: { id: itemId, workspaceId },
    });
    if (!item) throw new NotFoundException('Social content item not found.');
    assertPublicContentSafe(`${item.title}\n${item.caption ?? ''}`, 'TryPost content');

    const policy = await this.getOrCreatePolicy(workspaceId);
    if (policy.paused) {
      throw new ForbiddenException('Social Agent is paused; remote TryPost operations are blocked.');
    }

    if (options.mode === 'scheduled') {
      if (item.approvedVersion !== item.contentVersion || item.status !== 'APPROVED') {
        throw new ForbiddenException(
          'Scheduling in TryPost requires explicit approval of the current content version.',
        );
      }
      if (!options.scheduledAt) {
        throw new BadRequestException('A valid scheduledAt timestamp is required.');
      }
    }

    const auth = await this.trypostConnections.openAuth(workspaceId);
    if (!auth) {
      throw new ConflictException('TryPost is not connected for this workspace.');
    }

    if (options.mode === 'idea') {
      const created = await this.trypostClient.createIdea(auth, {
        title: item.title,
        content: item.caption || item.objective || item.title,
      });
      const updated = await this.prisma.socialContentItem.update({
        where: { id: item.id },
        data: { trypostIdeaId: created.id },
      });
      await this.prisma.socialAgentEvent.create({
        data: {
          workspaceId,
          eventType: 'trypost_idea_synced',
          summary: `Idea enviada al banco de ideas de TryPost: ${item.title}`,
          severity: 'success',
          metadata: { itemId: item.id, trypostIdeaId: created.id },
        },
      });
      return updated;
    }

    const channelIds =
      options.channelIds?.length
        ? options.channelIds
        : Array.isArray(item.targetChannelIds)
          ? (item.targetChannelIds as string[])
          : [];
    if (channelIds.length === 0) {
      throw new BadRequestException('Select at least one TryPost social account.');
    }

    const created = await this.trypostClient.createPost(auth, {
      content: item.caption || item.title,
      channelIds,
      status: options.mode === 'scheduled' ? 'scheduled' : 'draft',
      scheduledAt: options.scheduledAt ?? null,
      internalNote: `Crossmart Agente Social · objetivo: ${item.objective ?? 'general'} · v${item.contentVersion}`,
    });

    const updated = await this.prisma.socialContentItem.update({
      where: { id: item.id },
      data: {
        trypostPostId: created.id,
        status: options.mode === 'scheduled' ? 'SCHEDULED' : 'DRAFT_REMOTE',
        scheduledFor: options.scheduledAt ? new Date(options.scheduledAt) : null,
      },
    });

    await this.prisma.socialAgentEvent.create({
      data: {
        workspaceId,
        eventType: options.mode === 'scheduled' ? 'trypost_post_scheduled' : 'trypost_draft_created',
        summary:
          options.mode === 'scheduled'
            ? `Publicación aprobada programada en TryPost: ${item.title}`
            : `Borrador remoto creado en TryPost: ${item.title}`,
        severity: 'success',
        metadata: { itemId: item.id, trypostPostId: created.id },
      },
    });
    return updated;
  }

  // ─── Dynamic Creative Profiles ──────────────────────────────────────────────

  listCreativeProfiles(workspaceId: string) {
    return this.prisma.creativeProfile.findMany({
      where: { workspaceId, status: { not: 'ARCHIVED' } },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async createCreativeProfile(
    workspaceId: string,
    input: {
      name: string;
      objective?: string;
      instructions: string;
      references?: string[];
      restrictions?: string[];
      assets?: Array<{ name: string; kind: string; url?: string }>;
    },
  ) {
    const profile = await this.prisma.creativeProfile.create({
      data: {
        workspaceId,
        name: input.name.trim(),
        objective: input.objective?.trim() ?? null,
        instructions: input.instructions.trim(),
        references: (input.references ?? []) as unknown as Prisma.InputJsonValue,
        restrictions: (input.restrictions ?? []) as unknown as Prisma.InputJsonValue,
        assets: (input.assets ?? []) as unknown as Prisma.InputJsonValue,
        status: 'ACTIVE',
      },
    });

    await this.prisma.socialAgentEvent.create({
      data: {
        workspaceId,
        eventType: 'creative_profile_created',
        summary: `Perfil creativo creado: ${profile.name}`,
        severity: 'info',
        metadata: { profileId: profile.id },
      },
    });
    return profile;
  }

  async archiveCreativeProfile(workspaceId: string, profileId: string) {
    const existing = await this.prisma.creativeProfile.findFirst({
      where: { id: profileId, workspaceId },
    });
    if (!existing) throw new NotFoundException('Creative profile not found.');
    return this.prisma.creativeProfile.update({
      where: { id: existing.id },
      data: { status: 'ARCHIVED' },
    });
  }
}
