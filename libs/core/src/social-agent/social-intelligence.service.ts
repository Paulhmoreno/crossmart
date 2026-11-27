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

export const SOCIAL_PLANNING_SCHEDULER_ID = 'social-editorial-planning-periodic';
export const SOCIAL_PLANNING_JOB_NAME = 'social-editorial-planning';
export const SOCIAL_PLANNING_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Strictly public-safe commercial opportunity projection (NEVER contains cost or margin fields). */
export interface CommercialOpportunity {
  type: 'HIGH_STOCK' | 'SINGLE_UNIT_FEATURED' | 'EDUCATIONAL' | 'CATEGORY_SPOTLIGHT';
  title: string;
  rationale: string;
  productId?: string;
  sku?: string | null;
  price?: number | null;
  availableStock?: number | null;
  availabilityTier?: 'single_unit' | 'moderate' | 'high';
  creativeEffort?: 'lightweight_quick' | 'standard' | 'flagship';
  suggestedPillar: 'commercial' | 'educational' | 'informative' | 'brand';
}

/** Private internal profitability record (strictly for admin/Ads ROAS analysis, never public copy). */
export interface PrivateProfitabilityItem {
  productId: string;
  title: string;
  sku: string | null;
  price: number;
  cost: number;
  verifiableMarginPct: number;
  availableStock: number;
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
   * and returns STRICTLY PUBLIC-SAFE commercial opportunities (no cost/margin fields in the
   * projection). Treats inventory as a continuous variable so single-unit products with strong
   * commercial justification (e.g. unique/high-value items with real photos) remain eligible with
   * lightweight creative effort, while out-of-stock products remain protected from auto-promotion.
   */
  async analyzeBusinessOpportunities(workspaceId: string): Promise<{
    totalProducts: number;
    inStockProducts: number;
    singleUnitProducts: number;
    multiUnitProducts: number;
    analyzedSample: number;
    topCategories: string[];
    opportunities: CommercialOpportunity[];
  }> {
    const [totalProducts, inStockProducts, multiUnitProducts, categoryGroups, candidates] =
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
          select: {
            id: true,
            title: true,
            productType: true,
            variants: {
              select: {
                sku: true,
                price: true,
                // NOTE: `cost` is intentionally NOT selected in public opportunity queries!
                inventoryItem: { select: { available: true } },
              },
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

    const singleUnitProducts = Math.max(0, inStockProducts - multiUnitProducts);
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
        const availabilityTier: CommercialOpportunity['availabilityTier'] =
          totalAvailable >= 5 ? 'high' : totalAvailable >= 2 ? 'moderate' : 'single_unit';
        const creativeEffort: CommercialOpportunity['creativeEffort'] =
          availabilityTier === 'high'
            ? 'flagship'
            : availabilityTier === 'moderate'
              ? 'standard'
              : 'lightweight_quick';
        // Continuous scoring combining stock availability, real photography, and public price signal
        const score =
          Math.min(30, totalAvailable * 4) +
          (hasImage ? 20 : 0) +
          (price && price > 0 ? Math.min(15, Math.log10(price + 1) * 5) : 0);
        return { prod, totalAvailable, primary, price, hasImage, availabilityTier, creativeEffort, score };
      })
      .filter((entry) => entry.totalAvailable > 0)
      .sort((a, b) => b.score - a.score || b.totalAvailable - a.totalAvailable);

    const opportunities: CommercialOpportunity[] = [];
    for (const entry of scored) {
      if (opportunities.length >= 6) break;
      const isSingle = entry.availabilityTier === 'single_unit';
      opportunities.push({
        type:
          entry.availabilityTier === 'high'
            ? 'HIGH_STOCK'
            : isSingle
              ? 'SINGLE_UNIT_FEATURED'
              : 'CATEGORY_SPOTLIGHT',
        title: `Destacar en catálogo: ${entry.prod.title}`,
        rationale: `Disponibilidad verificada de ${entry.totalAvailable} unidad(es)${
          entry.price ? ` · precio público $${entry.price.toFixed(2)}` : ''
        }${entry.hasImage ? ' · cuenta con fotografía real en catálogo' : ''}${
          isSingle ? ' · recomendado formato ligero/rápido por unidad única' : ''
        }.`,
        productId: entry.prod.id,
        sku: entry.primary?.sku ?? null,
        price: entry.price,
        availableStock: entry.totalAvailable,
        availabilityTier: entry.availabilityTier,
        creativeEffort: entry.creativeEffort,
        suggestedPillar: 'commercial',
      });
    }

    if (topCategories.length > 0) {
      opportunities.push({
        type: 'EDUCATIONAL',
        title: `Guía práctica para elegir en ${topCategories[0]}`,
        rationale: `Categoría principal con stock verificado (${topCategories[0]}); contenido educativo fortalece autoridad sin depender únicamente de venta directa.`,
        creativeEffort: 'standard',
        suggestedPillar: 'educational',
      });
    } else if (totalProducts > 0) {
      opportunities.push({
        type: 'EDUCATIONAL',
        title: 'Contenido educativo sobre cómo elegir y aprovechar el catálogo',
        rationale: 'Equilibra el calendario editorial con valor informativo y preguntas frecuentes de clientes.',
        creativeEffort: 'standard',
        suggestedPillar: 'educational',
      });
    }

    return {
      totalProducts,
      inStockProducts,
      singleUnitProducts,
      multiUnitProducts,
      analyzedSample: candidates.length,
      topCategories,
      opportunities,
    };
  }

  /**
   * Private admin-only profitability analysis (reusable by Social strategy & future Agente Ads).
   * Strictly separated from public content generation tools.
   */
  async analyzePrivateProfitability(workspaceId: string, limit = 15): Promise<{
    audience: 'internal_admin_only';
    items: PrivateProfitabilityItem[];
  }> {
    const products = await this.prisma.product.findMany({
      where: {
        workspaceId,
        variants: {
          some: {
            cost: { not: null },
            inventoryItem: { available: { gt: 0 } },
          },
        },
      },
      select: {
        id: true,
        title: true,
        variants: {
          select: {
            sku: true,
            price: true,
            cost: true,
            inventoryItem: { select: { available: true } },
          },
        },
      },
      take: 100,
    });

    const items: PrivateProfitabilityItem[] = [];
    for (const prod of products) {
      const available = prod.variants.reduce((sum, v) => sum + (v.inventoryItem?.available ?? 0), 0);
      const primary = prod.variants[0];
      const price = primary ? Number(primary.price) : 0;
      const cost = primary?.cost ? Number(primary.cost) : 0;
      if (available <= 0 || price <= 0 || cost <= 0) continue;
      const marginPct = Math.round(((price - cost) / price) * 1000) / 10;
      items.push({
        productId: prod.id,
        title: prod.title,
        sku: primary?.sku ?? null,
        price,
        cost,
        verifiableMarginPct: marginPct,
        availableStock: available,
      });
    }

    items.sort((a, b) => b.verifiableMarginPct - a.verifiableMarginPct);
    return {
      audience: 'internal_admin_only',
      items: items.slice(0, Math.min(Math.max(limit, 1), 30)),
    };
  }

  /**
   * Controlled periodic editorial planning cycle for one workspace:
   * - Inspects TryPost calendar & analytics (read-only)
   * - Detects content gaps (e.g. < 2 upcoming posts/drafts)
   * - Analyzes catalog opportunities (public-safe)
   * - Creates at most 1 deduplicated local editorial proposal (`IDEA`, NEVER schedules/publishes)
   *   unless `dryRun: true`.
   */
  async runEditorialPlanningCycle(
    workspaceId: string,
    options?: { dryRun?: boolean; trigger?: 'worker' | 'manual' },
  ): Promise<{
    workspaceId: string;
    skippedReason?: string;
    calendarPostsCount: number;
    contentGapDetected: boolean;
    analyticsAvailable: boolean;
    opportunitiesFound: number;
    proposalsCreated: number;
    dryRun: boolean;
  }> {
    const policy = await this.getOrCreatePolicy(workspaceId);
    const trigger = options?.trigger ?? 'manual';
    const dryRun = Boolean(options?.dryRun);

    if (policy.paused) {
      return {
        workspaceId,
        skippedReason: 'paused',
        calendarPostsCount: 0,
        contentGapDetected: false,
        analyticsAvailable: false,
        opportunitiesFound: 0,
        proposalsCreated: 0,
        dryRun,
      };
    }

    if (trigger === 'worker' && policy.autonomyMode !== 'AUTOMATIC') {
      return {
        workspaceId,
        skippedReason: `autonomy_mode_${policy.autonomyMode.toLowerCase()}`,
        calendarPostsCount: 0,
        contentGapDetected: false,
        analyticsAvailable: false,
        opportunitiesFound: 0,
        proposalsCreated: 0,
        dryRun,
      };
    }

    const [auth, analysis] = await Promise.all([
      this.trypostConnections.openAuth(workspaceId),
      this.analyzeBusinessOpportunities(workspaceId),
    ]);

    let calendarPostsCount = 0;
    let analyticsAvailable = false;
    if (auth) {
      const [posts, analytics] = await Promise.all([
        this.trypostClient.listPosts(auth).catch(() => []),
        this.trypostClient.getWorkspaceAnalytics(auth).catch(() => null),
      ]);
      calendarPostsCount = posts.length;
      analyticsAvailable = Boolean(analytics);
    }

    const contentGapDetected = calendarPostsCount < 2;
    let proposalsCreated = 0;

    if (!dryRun && contentGapDetected && analysis.opportunities.length > 0) {
      const top = analysis.opportunities[0];
      const existing = await this.prisma.socialContentItem.findFirst({
        where: { workspaceId, title: { equals: top.title, mode: 'insensitive' } },
      });
      if (!existing) {
        await this.createContentItem(workspaceId, {
          kind: 'IDEA',
          title: top.title,
          caption: top.rationale,
          objective: 'Cobertura de espacio en calendario editorial',
          pillar: top.suggestedPillar,
          productionMode: 'ASSISTED',
        });
        proposalsCreated = 1;
      }
    }

    await this.prisma.socialAgentEvent
      .create({
        data: {
          workspaceId,
          eventType: 'editorial_planning_cycle',
          summary: `Revisión editorial (${trigger}${dryRun ? ', simulación' : ''}): ${calendarPostsCount} publicación(es) en TryPost, ${analysis.opportunities.length} oportunidad(es), ${proposalsCreated} propuesta(s) generada(s).`,
          severity: 'info',
          metadata: {
            trigger,
            dryRun,
            calendarPostsCount,
            contentGapDetected,
            analyticsAvailable,
            proposalsCreated,
          },
        },
      })
      .catch(() => undefined);

    return {
      workspaceId,
      calendarPostsCount,
      contentGapDetected,
      analyticsAvailable,
      opportunitiesFound: analysis.opportunities.length,
      proposalsCreated,
      dryRun,
    };
  }

  /**
   * Invoked by Crossmart Worker (`MaintenanceProcessor`). Strictly only processes workspaces
   * whose owner explicitly authorized `autonomyMode === 'AUTOMATIC'` and `paused === false`.
   */
  async runAuthorizedPeriodicPlanning(): Promise<{ checked: number; executed: number }> {
    const authorized = await this.prisma.socialBudgetPolicy.findMany({
      where: { paused: false, autonomyMode: 'AUTOMATIC' },
      select: { workspaceId: true },
    });
    let executed = 0;
    for (const row of authorized) {
      const res = await this.runEditorialPlanningCycle(row.workspaceId, {
        dryRun: false,
        trigger: 'worker',
      });
      if (!res.skippedReason) executed += 1;
    }
    return { checked: authorized.length, executed };
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
