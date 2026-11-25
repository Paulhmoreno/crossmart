import { Injectable } from '@nestjs/common';
import type { ChannelSession } from '../../sdk/auth/channel-session.js';
import type { CatalogSource } from '../../sdk/capabilities/catalog-source.js';
import type {
  ChannelPage,
  ExternalProduct,
  ExternalVariant,
} from '../../sdk/capabilities/catalog.types.js';
import { HttpMethod } from '../../sdk/http/http-method.enum.js';
import { wooCommerceAccount } from '../account/woocommerce-credentials.js';
import { WooCommerceApiClient } from '../api/woocommerce-api.client.js';
import type { WooProduct, WooVariation } from '../api/woocommerce-api.types.js';
import {
  WOOCOMMERCE_CATALOG_PAGE_SIZE,
  WOOCOMMERCE_INVENTORY_ID_SEPARATOR,
} from '../woocommerce.constants.js';

const FIRST_PAGE = 1;
const DECIMAL_PLACES = 2;
const GRAMS_PER_KG = 1000;
const GRAMS_PER_LB = 453.59237;
const GRAMS_PER_OZ = 28.349523125;

function parseDecimal(raw: string | null | undefined): string {
  if (!raw || !raw.trim()) return '0.00';
  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric < 0) return '0.00';
  return numeric.toFixed(DECIMAL_PLACES);
}

function parseWeightGrams(rawWeight: string | null | undefined, weightUnit: string): number | null {
  if (!rawWeight || !rawWeight.trim()) return null;
  const numeric = Number(rawWeight);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  switch (weightUnit.toLowerCase()) {
    case 'g':
      return Math.round(numeric);
    case 'lbs':
      return Math.round(numeric * GRAMS_PER_LB);
    case 'oz':
      return Math.round(numeric * GRAMS_PER_OZ);
    default:
      return Math.round(numeric * GRAMS_PER_KG);
  }
}

function resolvePrices(
  regularPrice: string | undefined,
  salePrice: string | undefined,
  currentPrice: string | undefined,
): { price: string; compareAtPrice: string | null } {
  const regular = Number(regularPrice ?? '');
  const sale = Number(salePrice ?? '');
  if (Number.isFinite(sale) && sale > 0 && Number.isFinite(regular) && regular > sale) {
    return { price: parseDecimal(salePrice), compareAtPrice: parseDecimal(regularPrice) };
  }
  const effective = regularPrice?.trim() ? regularPrice : currentPrice;
  return { price: parseDecimal(effective), compareAtPrice: null };
}

function mapSimpleVariant(product: WooProduct, weightUnit: string): ExternalVariant {
  const { price, compareAtPrice } = resolvePrices(
    product.regular_price,
    product.sale_price,
    product.price,
  );
  return {
    externalId: String(product.id),
    externalInventoryId: String(product.id),
    sku: product.sku?.trim() || null,
    barcode: product.global_unique_id?.trim() || null,
    optionValues: [],
    price,
    compareAtPrice,
    tracked: Boolean(product.manage_stock),
    available: product.manage_stock ? Math.max(0, Math.floor(product.stock_quantity ?? 0)) : null,
    weightGrams: parseWeightGrams(product.weight, weightUnit),
    requiresShipping: product.shipping_required ?? true,
    taxable: (product.tax_status ?? 'taxable') !== 'none',
    continueSellingWhenOutOfStock: product.backorders === 'yes' || product.backorders === 'notify',
    unitCost: null,
  };
}

function mapVariation(
  productId: number,
  variation: WooVariation,
  optionNames: string[],
  weightUnit: string,
): ExternalVariant {
  const { price, compareAtPrice } = resolvePrices(
    variation.regular_price,
    variation.sale_price,
    variation.price,
  );
  const valueByName = new Map(
    variation.attributes.map((attr) => [attr.name.trim().toLowerCase(), attr.option.trim()]),
  );
  const optionValues = optionNames.map(
    (name) => valueByName.get(name.trim().toLowerCase()) ?? 'Default',
  );
  return {
    externalId: String(variation.id),
    externalInventoryId: `${productId}${WOOCOMMERCE_INVENTORY_ID_SEPARATOR}${variation.id}`,
    sku: variation.sku?.trim() || null,
    barcode: variation.global_unique_id?.trim() || null,
    optionValues,
    price,
    compareAtPrice,
    tracked: Boolean(variation.manage_stock),
    available: variation.manage_stock
      ? Math.max(0, Math.floor(variation.stock_quantity ?? 0))
      : null,
    weightGrams: parseWeightGrams(variation.weight, weightUnit),
    requiresShipping: true,
    taxable: (variation.tax_status ?? 'taxable') !== 'none',
    continueSellingWhenOutOfStock:
      variation.backorders === 'yes' || variation.backorders === 'notify',
    unitCost: null,
  };
}

/**
 * Reads existing WooCommerce products (simple and variable) page by page so Crossmart's
 * native import pipeline can link unambiguous SKU/remote-ID matches without duplicates.
 */
@Injectable()
export class WooCommerceCatalogSource implements CatalogSource {
  constructor(private readonly api: WooCommerceApiClient) {}

  async fetchProducts(
    session: ChannelSession,
    cursor: string | null,
  ): Promise<ChannelPage<ExternalProduct>> {
    const { account } = await wooCommerceAccount(session);
    const page = cursor
      ? Math.max(FIRST_PAGE, Number.parseInt(cursor, 10) || FIRST_PAGE)
      : FIRST_PAGE;
    const response = await this.api.request<WooProduct[]>(
      account,
      HttpMethod.Get,
      `/products?per_page=${WOOCOMMERCE_CATALOG_PAGE_SIZE}&page=${page}&status=any&orderby=id&order=asc`,
    );

    const rows = Array.isArray(response.data) ? response.data : [];
    const totalPages = Number.parseInt(response.headers['x-wp-totalpages'] ?? '1', 10) || 1;
    const totalCount = Number.parseInt(response.headers['x-wp-total'] ?? '', 10);

    const items: ExternalProduct[] = [];
    for (const row of rows) {
      if (row.status === 'trash') continue;
      items.push(await this.toExternalProduct(account, row));
    }

    const nextCursor = page < totalPages && rows.length > 0 ? String(page + 1) : null;
    return {
      items,
      nextCursor,
      totalCount: Number.isInteger(totalCount) ? totalCount : null,
    };
  }

  private async toExternalProduct(
    account: { storeUrl: string; consumerKey: string; consumerSecret: string; weightUnit: string },
    product: WooProduct,
  ): Promise<ExternalProduct> {
    const variationAttrs = (product.attributes ?? []).filter((attr) => attr.variation);
    const optionNames =
      product.type === 'variable' ? variationAttrs.map((attr) => attr.name.trim()) : [];

    let variants: ExternalVariant[];
    if (product.type === 'variable') {
      const variations = await this.fetchVariations(account, product.id);
      variants =
        variations.length > 0
          ? variations.map((variation) =>
              mapVariation(product.id, variation, optionNames, account.weightUnit),
            )
          : [mapSimpleVariant(product, account.weightUnit)];
    } else {
      variants = [mapSimpleVariant(product, account.weightUnit)];
    }

    const primaryCategory = product.categories?.[0]?.name?.trim() ?? null;
    const tags = (product.tags ?? [])
      .map((tag) => tag.name?.trim() ?? '')
      .filter((name) => name.length > 0);
    const images = (product.images ?? [])
      .filter((img) => Boolean(img.src?.trim()))
      .map((img) => ({
        url: img.src.trim(),
        altText: img.alt?.trim() || null,
      }));

    return {
      externalId: String(product.id),
      handle: product.slug?.trim() || `woocommerce-${product.id}`,
      title: product.name?.trim() || `Producto ${product.id}`,
      descriptionHtml: product.description ?? '',
      vendor: null,
      productType: primaryCategory,
      tags,
      active: product.status === 'publish',
      optionNames,
      variants,
      images,
      externalUrl: product.permalink?.trim() || null,
    };
  }

  private async fetchVariations(
    account: { storeUrl: string; consumerKey: string; consumerSecret: string },
    productId: number,
  ): Promise<WooVariation[]> {
    const response = await this.api.request<WooVariation[]>(
      account,
      HttpMethod.Get,
      `/products/${productId}/variations?per_page=100`,
    );
    return Array.isArray(response.data) ? response.data : [];
  }
}
