import { Injectable } from '@nestjs/common';
import { ListingStatus, OutOfStockPolicy, PrismaService, ProductStatus } from '@crossmart/database';
import type { AiToolDefinition } from '../ai/entities/ai-conversation.js';
import { ChannelPriceResolver } from '../listings/services/channel-price-resolver.js';
import type { SalesCommercialPolicy } from './agent-configs.service.js';

const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 12;
const MAX_DESCRIPTION_CHARS = 500;
const MAX_IMAGES_PER_PRODUCT = 4;

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
  currencyCode: string;
  images: string[];
  buyUrls: Array<{ storeName: string; url: string }>;
  variants: SafeBuyerVariantView[];
}

export interface SalesToolExecutionResult {
  output: Record<string, unknown>;
  handoff?: { reason: string };
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DESCRIPTION_CHARS);
}

/**
 * Backend-enforced, strictly read-only commercial tools for the Sales Agent.
 * NEVER queries or returns `cost`, `unitCost`, internal margins, credentials, private ERP
 * metadata, or write/delete operations — enforced at the Prisma select & tool boundary.
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
          'Search commercially available active products in the catalog by keywords, SKU, or brand. Returns titles, descriptions, current prices, real stock availability, variants, photos, and public purchase links.',
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
      return { output: { count: products.length, products } };
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

    const products = await this.prisma.product.findMany({
      where: {
        workspaceId,
        status: ProductStatus.ACTIVE,
        ...(query
          ? {
              OR: [
                { title: { contains: query, mode: 'insensitive' } },
                { vendor: { contains: query, mode: 'insensitive' } },
                { descriptionHtml: { contains: query, mode: 'insensitive' } },
                { variants: { some: { sku: { contains: query, mode: 'insensitive' } } } },
              ],
            }
          : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take: limit,
      select: this.safeProductSelect(),
    });

    return products.map((product) => this.toSafeBuyerView(product, currencyCode, policy));
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
      where: { id: productId, workspaceId, status: ProductStatus.ACTIVE },
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
      currencyCode,
      images: product.media.map((item) => item.url),
      buyUrls,
      variants,
    };
  }
}
