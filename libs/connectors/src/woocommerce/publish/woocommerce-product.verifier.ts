import { ChannelType } from '../../sdk/channel-type.enum.js';
import { ChannelError } from '../../sdk/errors/channel-error.js';
import { ChannelErrorCode } from '../../sdk/errors/channel-error-code.enum.js';
import { PublishRequirement } from '../../sdk/publishing/publish-requirement.enum.js';
import type {
  WooMetaEntry,
  WooProduct,
  WooProductAttribute,
  WooVariation,
} from '../api/woocommerce-api.types.js';
import {
  decodeHtmlEntities,
  normalizeExactTermName,
} from '../taxonomy/woocommerce-taxonomy.provider.js';
import { WOOCOMMERCE_META_PRODUCT_ID } from '../woocommerce.constants.js';
import type { WooMediaPayloadItem } from './woocommerce-media.uploader.js';

const PRICE_EPSILON = 0.005;

export interface ExpectedPersistedVariant {
  externalId: string;
  sku: string | null;
  barcode: string | null;
  regularPrice: string;
  salePrice: string;
  tracked: boolean;
  stockQuantity: number | null;
  stockStatus: string;
}

export interface ExpectedPersistedProduct {
  productId: string;
  name: string;
  description: string;
  shortDescription: string;
  status: string;
  variable: boolean;
  categoryId: number | null;
  brandId: number | null;
  tagIds: readonly number[] | null;
  removedTagIds: readonly number[];
  attributes: readonly WooProductAttribute[] | null;
  expectedImages: readonly WooMediaPayloadItem[] | null;
  expectedImageCount: number;
  simple?: {
    sku: string | null;
    barcode: string | null;
    regularPrice: string;
    salePrice: string;
    tracked: boolean;
    stockQuantity: number | null;
    stockStatus: string;
  };
  variants?: readonly ExpectedPersistedVariant[];
}

/**
 * WordPress applies `wpautop` and entity normalization to rich text fields. Comparing normalized
 * plain text avoids false drift while still detecting dropped or corrupted content.
 */
export function sameRichText(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const normalize = (raw: string | null | undefined): string =>
    decodeHtmlEntities(String(raw ?? ''))
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;|\u00a0/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  return normalize(left) === normalize(right);
}

export function sameNumericPrice(
  expected: string | null | undefined,
  actual: string | null | undefined,
): boolean {
  const exp = (expected ?? '').trim();
  const act = (actual ?? '').trim();
  if (!exp && !act) return true;
  const numExp = Number(exp);
  const numAct = Number(act);
  if (Number.isFinite(numExp) && Number.isFinite(numAct)) {
    return Math.abs(numExp - numAct) < PRICE_EPSILON;
  }
  return exp === act;
}

function hasOwnershipMeta(
  metaData: readonly WooMetaEntry[] | undefined,
  productId: string,
): boolean {
  return Boolean(
    metaData?.some(
      (entry) => entry.key === WOOCOMMERCE_META_PRODUCT_ID && entry.value === productId,
    ),
  );
}

function verifyTaxonomyGaps(expected: ExpectedPersistedProduct, observed: WooProduct): string[] {
  const gaps: string[] = [];
  if (expected.categoryId !== null) {
    const hasCat = (observed.categories ?? []).some((cat) => cat.id === expected.categoryId);
    if (!hasCat) gaps.push(`category=${expected.categoryId}`);
  }
  if (expected.brandId !== null) {
    const hasBrand = (observed.brands ?? []).some((brand) => brand.id === expected.brandId);
    if (!hasBrand) gaps.push(`brand=${expected.brandId}`);
  }
  if (expected.tagIds !== null) {
    const observedTagIds = new Set((observed.tags ?? []).map((tag) => tag.id));
    const missing = expected.tagIds.filter((id) => !observedTagIds.has(id));
    if (missing.length > 0) gaps.push(`tags_missing=${missing.join(',')}`);
    const leftover = expected.removedTagIds.filter((id) => observedTagIds.has(id));
    if (leftover.length > 0) gaps.push(`tags_not_removed=${leftover.join(',')}`);
  }
  if (expected.attributes !== null && expected.attributes.length > 0) {
    const observedAttrs = observed.attributes ?? [];
    for (const attr of expected.attributes) {
      const matched = attr.id
        ? observedAttrs.some((row) => row.id === attr.id)
        : observedAttrs.some(
            (row) => normalizeExactTermName(row.name) === normalizeExactTermName(attr.name),
          );
      if (!matched) gaps.push(`attribute=${attr.name}`);
    }
  }
  return gaps;
}

function verifyImageGaps(expected: ExpectedPersistedProduct, observed: WooProduct): string[] {
  const actualImages = observed.images ?? [];
  if (expected.expectedImages !== null) {
    if (actualImages.length < expected.expectedImages.length) {
      return [`images=${actualImages.length}/${expected.expectedImages.length}`];
    }
    const orderMismatch = expected.expectedImages.some((item, index) => {
      if (!('id' in item)) return false;
      return actualImages[index]?.id !== item.id;
    });
    if (orderMismatch) return ['images=order_or_id_mismatch'];
    return [];
  }
  if (expected.expectedImageCount > 0 && actualImages.length < expected.expectedImageCount) {
    return [`images=${actualImages.length}/${expected.expectedImageCount}`];
  }
  return [];
}

function verifySimpleGaps(
  simple: NonNullable<ExpectedPersistedProduct['simple']>,
  observed: WooProduct,
): string[] {
  const gaps: string[] = [];
  if (simple.sku && (observed.sku ?? '').trim() !== simple.sku.trim()) {
    gaps.push('sku');
  }
  if (simple.barcode && (observed.global_unique_id ?? '').trim() !== simple.barcode.trim()) {
    gaps.push('global_unique_id');
  }
  if (!sameNumericPrice(simple.regularPrice, observed.regular_price)) {
    gaps.push('regular_price');
  }
  if (simple.salePrice && !sameNumericPrice(simple.salePrice, observed.sale_price)) {
    gaps.push('sale_price');
  }
  if (simple.tracked) {
    if (!observed.manage_stock) gaps.push('manage_stock');
    if (observed.stock_quantity !== simple.stockQuantity) gaps.push('stock_quantity');
    if (observed.stock_status !== simple.stockStatus) gaps.push('stock_status');
  }
  return gaps;
}

function verifyVariantGaps(
  expectedVariants: readonly ExpectedPersistedVariant[],
  observedVariations: readonly WooVariation[],
): string[] {
  const byId = new Map(observedVariations.map((row) => [String(row.id), row]));
  const gaps: string[] = [];
  for (const variant of expectedVariants) {
    const remote = byId.get(variant.externalId);
    if (!remote) {
      gaps.push(`variation_missing=${variant.externalId}`);
      continue;
    }
    if (variant.sku && (remote.sku ?? '').trim() !== variant.sku.trim()) {
      gaps.push(`variation_sku=${variant.externalId}`);
    }
    if (variant.barcode && (remote.global_unique_id ?? '').trim() !== variant.barcode.trim()) {
      gaps.push(`variation_barcode=${variant.externalId}`);
    }
    if (!sameNumericPrice(variant.regularPrice, remote.regular_price)) {
      gaps.push(`variation_price=${variant.externalId}`);
    }
    if (variant.salePrice && !sameNumericPrice(variant.salePrice, remote.sale_price)) {
      gaps.push(`variation_sale_price=${variant.externalId}`);
    }
    if (variant.tracked && remote.stock_quantity !== variant.stockQuantity) {
      gaps.push(`variation_stock=${variant.externalId}`);
    }
  }
  return gaps;
}

/**
 * Verifies a persisted WooCommerce product (and variations when variable) by comparing the
 * read-back state against what Crossmart sent, accounting for legitimate WooCommerce normalizations
 * while failing explicitly when fields were lost, corrupted, or silently rejected.
 */
export function assertPersistedWooProduct(
  expected: ExpectedPersistedProduct,
  observed: WooProduct,
  observedVariations: readonly WooVariation[] = [],
): void {
  const gaps: string[] = [];
  if (observed.status !== expected.status) {
    gaps.push(`status=${observed.status ?? 'unknown'}`);
  }
  if (!hasOwnershipMeta(observed.meta_data, expected.productId)) {
    gaps.push('ownership_meta');
  }
  if (normalizeExactTermName(observed.name ?? '') !== normalizeExactTermName(expected.name)) {
    gaps.push('name');
  }
  if (!sameRichText(expected.description, observed.description)) {
    gaps.push('description');
  }
  if (!sameRichText(expected.shortDescription, observed.short_description)) {
    gaps.push('short_description');
  }

  gaps.push(...verifyTaxonomyGaps(expected, observed));
  const imageGaps = verifyImageGaps(expected, observed);
  gaps.push(...imageGaps);

  if (!expected.variable && expected.simple) {
    gaps.push(...verifySimpleGaps(expected.simple, observed));
  }
  if (expected.variable && expected.variants) {
    gaps.push(...verifyVariantGaps(expected.variants, observedVariations));
  }

  if (gaps.length > 0) {
    const requirement = imageGaps.length > 0 ? PublishRequirement.Images : undefined;
    throw new ChannelError(
      ChannelType.WooCommerce,
      ChannelErrorCode.RequestRejected,
      `WooCommerce no confirmó todos los campos enviados en el producto #${observed.id} (${gaps.join(', ')}).`,
      requirement,
    );
  }
}
