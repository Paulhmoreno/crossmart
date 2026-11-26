import { Injectable } from '@nestjs/common';
import { ListingStatus, OutOfStockPolicy, PrismaService, ProductStatus } from '@crossmart/database';
import type { AiToolDefinition } from '../ai/entities/ai-conversation.js';
import { ChannelPriceResolver } from '../listings/services/channel-price-resolver.js';
import type { SalesCommercialPolicy } from './agent-configs.service.js';

const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 12;
const MAX_DESCRIPTION_CHARS = 500;
const MAX_IMAGES_PER_PRODUCT = 4;
const MIN_TOKEN_LENGTH = 2;
const MIN_ES_STEM_LENGTH = 5;
const ES_SUFFIX_LENGTH = 2;
const MIN_S_STEM_LENGTH = 4;
const MAX_EXPANDED_TOKENS = 8;
const SEARCH_CANDIDATE_MULTIPLIER = 3;
const MIN_SEARCH_CANDIDATES = 24;

export interface SafeBuyerVariantView {
  variantId: string;
  sku: string | null;
  optionValues: string[];
  price: string;
  compareAtPrice: string | null;
  inStock: boolean;
  availableQuantity: number | null;
}

export interface SafeBuyerProductView {
  productId: string;
  title: string;
  description: string;
  vendor: string | null;
  tags: string[];
  commercialStatus: 'active' | 'draft';
  publishedExternally: boolean;
  offerAuthorized: boolean;
  currencyCode: string;
  images: string[];
  buyUrls: Array<{ storeName: string; url: string }>;
  variants: SafeBuyerVariantView[];
}

export interface SalesToolExecutionResult {
  output: Record<string, unknown>;
  handoff?: { reason: string };
  matchedProductIds?: string[];
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DESCRIPTION_CHARS);
}

function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * Generates accent-insensitive search terms including singular stems (e.g. `tocadiscos` -> `tocadisco`)
 * so natural Spanish/English buyer queries match real catalog titles reliably.
 */
export function expandSearchTokens(rawQuery: string): string[] {
  const stopWords = new Set([
    'de',
    'del',
    'la',
    'el',
    'los',
    'las',
    'un',
    'una',
    'unos',
    'unas',
    'en',
    'con',
    'para',
    'por',
    'the',
    'for',
    'and',
  ]);
  const tokens = rawQuery
    .trim()
    .split(/[\s,.;:!?/\\()]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= MIN_TOKEN_LENGTH && !stopWords.has(normalizeText(part)));

  const expanded = new Set<string>();
  for (const token of tokens) {
    expanded.add(token);
    const plain = normalizeText(token);
    if (plain !== token.toLowerCase()) expanded.add(plain);
    if (plain.length >= MIN_ES_STEM_LENGTH && plain.endsWith('es') && !plain.endsWith('tes')) {
      expanded.add(plain.slice(0, -ES_SUFFIX_LENGTH));
    }
    if (plain.length >= MIN_S_STEM_LENGTH && plain.endsWith('s')) {
      expanded.add(plain.slice(0, -1));
    }
  }
  return [...expanded].slice(0, MAX_EXPANDED_TOKENS);
}

/**
 * Backend-enforced, strictly read-only commercial tools for the Sales Agent.
 * NEVER queries or returns `cost`, `unitCost`, internal margins, credentials, private ERP
 * metadata, or write/delete operations — enforced at the Prisma select & tool boundary.
 *
 * Includes both `ACTIVE` and `DRAFT` workspace products (excluding `ARCHIVED`), clearly
 * differentiating commercial status, external publication status, stock availability, and
 * offer authorization without equating draft products with out-of-stock products.
 */
@Injectable()
export class SalesAgentToolsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly priceResolver: ChannelPriceResolver,
  ) {}

  definitions(): AiToolDefinition[] {
    return [
      {
        name: 'search_catalog_products',
        description:
          'Search authorized workspace products (including catalog drafts not yet published on external stores) by keywords, SKU, brand, or listing reference. Returns titles, real prices, real stock availability, commercial/publication status, variants, photos, and public purchase links.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search terms, product name, brand, or SKU.' },
            limit: { type: 'number', description: 'Max number of products to return (1-12).' },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_product_commercial_details',
        description:
          'Get complete buyer-safe commercial details for a specific product by productId, including variants, current prices, real stock, authorized photos, purchase links, and configured commercial conditions.',
        inputSchema: {
          type: 'object',
          properties: {
            productId: { type: 'string', description: 'UUID of the product.' },
          },
          required: ['productId'],
        },
      },
      {
        name: 'handoff_to_human',
        description:
          'Transfer the conversation to a human sales or support specialist when the buyer asks for custom quotes, verified payment confirmation, order issues, or explicit human assistance.',
        inputSchema: {
          type: 'object',
          properties: {
            reason: { type: 'string', description: 'Brief factual reason for human handoff.' },
          },
          required: ['reason'],
        },
      },
    ];
  }

  async execute(
    workspaceId: string,
    toolName: string,
    input: Record<string, unknown>,
    policy: SalesCommercialPolicy,
  ): Promise<SalesToolExecutionResult> {
    if (toolName === 'search_catalog_products') {
      const query = typeof input.query === 'string' ? input.query.trim() : '';
      const rawLimit = typeof input.limit === 'number' ? input.limit : DEFAULT_SEARCH_LIMIT;
      const limit = Math.min(Math.max(Math.floor(rawLimit), 1), MAX_SEARCH_LIMIT);
      const products = await this.searchProducts(workspaceId, query, limit, policy);
      return {
        output: { count: products.length, products },
        matchedProductIds: products.map((product) => product.productId),
      };
    }
    if (toolName === 'get_product_commercial_details') {
      const productId = typeof input.productId === 'string' ? input.productId.trim() : '';
      const product = productId ? await this.getProduct(workspaceId, productId, policy) : null;
      return {
        output: {
          found: Boolean(product),
          product,
          commercialConditions: {
            paymentNotes: policy.paymentNotes ?? null,
            deliveryNotes: policy.deliveryNotes ?? null,
            warrantyNotes: policy.warrantyNotes ?? null,
          },
        },
        matchedProductIds: product ? [product.productId] : [],
      };
    }
    if (toolName === 'handoff_to_human') {
      const reason =
        typeof input.reason === 'string' && input.reason.trim().length > 0
          ? input.reason.trim()
          : 'Buyer requested human assistance';
      return {
        output: { handedOff: true, reason },
        handoff: { reason },
      };
    }
    return { output: { error: `Tool '${toolName}' is not permitted for the Sales Agent.` } };
  }

  /**
   * Resolves a product directly from normalized channel context (listing ID, SKU, or product ref)
   * so the agent knows which product a buyer is asking about without redundant questions.
   */
  async lookupProductByReference(
    workspaceId: string,
    ref: { listingId?: string | null; sku?: string | null; productRef?: string | null },
    policy: SalesCommercialPolicy,
  ): Promise<SafeBuyerProductView | null> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { currency: true },
    });
    const currencyCode = workspace?.currency ?? 'USD';

    const sku = ref.sku?.trim();
    const listingId = ref.listingId?.trim();
    const productRef = ref.productRef?.trim();

    if (sku) {
      const bySku = await this.prisma.product.findFirst({
        where: {
          workspaceId,
          status: { in: [ProductStatus.ACTIVE, ProductStatus.DRAFT] },
          variants: { some: { sku: { equals: sku, mode: 'insensitive' } } },
        },
        select: this.safeProductSelect(),
      });
      if (bySku) return this.toSafeBuyerView(bySku, currencyCode, policy);
    }

    if (listingId) {
      const byListing = await this.prisma.product.findFirst({
        where: {
          workspaceId,
          status: { in: [ProductStatus.ACTIVE, ProductStatus.DRAFT] },
          listings: { some: { externalId: { equals: listingId, mode: 'insensitive' } } },
        },
        select: this.safeProductSelect(),
      });
      if (byListing) return this.toSafeBuyerView(byListing, currencyCode, policy);
    }

    if (productRef) {
      const matches = await this.searchProducts(workspaceId, productRef, 1, policy);
      if (matches[0]) return matches[0];
    }

    return null;
  }

  async searchProducts(
    workspaceId: string,
    query: string,
    limit: number,
    policy: SalesCommercialPolicy,
  ): Promise<SafeBuyerProductView[]> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { currency: true },
    });
    const currencyCode = workspace?.currency ?? 'USD';
    const tokens = query ? expandSearchTokens(query) : [];

    const orClauses = tokens.flatMap((token) => [
      { title: { contains: token, mode: 'insensitive' as const } },
      { vendor: { contains: token, mode: 'insensitive' as const } },
      { descriptionHtml: { contains: token, mode: 'insensitive' as const } },
      { variants: { some: { sku: { contains: token, mode: 'insensitive' as const } } } },
      { listings: { some: { externalId: { equals: token, mode: 'insensitive' as const } } } },
    ]);

    const products = await this.prisma.product.findMany({
      where: {
        workspaceId,
        status: { in: [ProductStatus.ACTIVE, ProductStatus.DRAFT] },
        ...(orClauses.length > 0 ? { OR: orClauses } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take: Math.max(limit * SEARCH_CANDIDATE_MULTIPLIER, MIN_SEARCH_CANDIDATES),
      select: this.safeProductSelect(),
    });

    const mapped = products.map((product) => this.toSafeBuyerView(product, currencyCode, policy));
    const normTokens = tokens.map((token) => normalizeText(token));

    // Rank: in-stock products with most token matches in title/SKU first.
    mapped.sort((left, right) => {
      const leftStock = left.variants.some((variant) => variant.inStock) ? 1 : 0;
      const rightStock = right.variants.some((variant) => variant.inStock) ? 1 : 0;
      if (leftStock !== rightStock) return rightStock - leftStock;
      const scoreOf = (item: SafeBuyerProductView): number => {
        const hay = normalizeText(
          `${item.title} ${item.vendor ?? ''} ${item.variants.map((variant) => variant.sku ?? '').join(' ')}`,
        );
        return normTokens.reduce((acc, tok) => acc + (hay.includes(tok) ? 1 : 0), 0);
      };
      return scoreOf(right) - scoreOf(left);
    });

    return mapped.slice(0, limit);
  }

  async getProduct(
    workspaceId: string,
    productId: string,
    policy: SalesCommercialPolicy,
  ): Promise<SafeBuyerProductView | null> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { currency: true },
    });
    const currencyCode = workspace?.currency ?? 'USD';
    const product = await this.prisma.product.findFirst({
      where: {
        id: productId,
        workspaceId,
        status: { in: [ProductStatus.ACTIVE, ProductStatus.DRAFT] },
      },
      select: this.safeProductSelect(),
    });
    return product ? this.toSafeBuyerView(product, currencyCode, policy) : null;
  }

  /** Strictly selects ONLY buyer-safe commercial fields; `cost` and `sourceMetadata` are NEVER selected. */
  private safeProductSelect() {
    return {
      id: true,
      title: true,
      descriptionHtml: true,
      vendor: true,
      tags: true,
      status: true,
      media: {
        orderBy: { position: 'asc' as const },
        take: MAX_IMAGES_PER_PRODUCT,
        select: { url: true },
      },
      listings: {
        where: { status: ListingStatus.ACTIVE, externalUrl: { not: null } },
        select: {
          externalUrl: true,
          connection: { select: { id: true, displayName: true } },
        },
      },
      variants: {
        orderBy: { position: 'asc' as const },
        select: {
          id: true,
          sku: true,
          optionValues: true,
          price: true,
          compareAtPrice: true,
          outOfStockPolicy: true,
          inventoryItem: { select: { tracked: true, available: true } },
        },
      },
    };
  }

  private toSafeBuyerView(
    product: {
      id: string;
      title: string;
      descriptionHtml: string;
      vendor: string | null;
      tags: string[];
      status: ProductStatus;
      media: Array<{ url: string }>;
      listings: Array<{
        externalUrl: string | null;
        connection: { id: string; displayName: string };
      }>;
      variants: Array<{
        id: string;
        sku: string | null;
        optionValues: string[];
        price: { toString(): string };
        compareAtPrice: { toString(): string } | null;
        outOfStockPolicy: OutOfStockPolicy;
        inventoryItem: { tracked: boolean; available: number } | null;
      }>;
    },
    currencyCode: string,
    _policy: SalesCommercialPolicy,
  ): SafeBuyerProductView {
    const variants: SafeBuyerVariantView[] = product.variants.map((variant) => {
      const resolved = this.priceResolver.resolve(
        {
          price: variant.price.toString(),
          compareAtPrice: variant.compareAtPrice?.toString() ?? null,
          cost: null, // Never passed to buyer-facing resolution
        },
        { currencyCode, rule: null },
      );
      const tracked = variant.inventoryItem?.tracked ?? false;
      const available = tracked ? Math.max(variant.inventoryItem?.available ?? 0, 0) : null;
      const inStock =
        !tracked ||
        variant.outOfStockPolicy === OutOfStockPolicy.CONTINUE_SELLING ||
        (available !== null && available > 0);
      return {
        variantId: variant.id,
        sku: variant.sku,
        optionValues: variant.optionValues,
        price: resolved.price,
        compareAtPrice: resolved.compareAtPrice,
        inStock,
        availableQuantity: available,
      };
    });

    const buyUrls = product.listings
      .filter(
        (
          listing,
        ): listing is { externalUrl: string; connection: { id: string; displayName: string } } =>
          Boolean(listing.externalUrl),
      )
      .map((listing) => ({
        storeName: listing.connection.displayName,
        url: listing.externalUrl,
      }));

    return {
      productId: product.id,
      title: product.title,
      description: stripHtml(product.descriptionHtml),
      vendor: product.vendor,
      tags: product.tags,
      commercialStatus: product.status === ProductStatus.ACTIVE ? 'active' : 'draft',
      publishedExternally: buyUrls.length > 0,
      offerAuthorized: product.status !== ProductStatus.ARCHIVED,
      currencyCode,
      images: product.media.map((item) => item.url),
      buyUrls,
      variants,
    };
  }
}
