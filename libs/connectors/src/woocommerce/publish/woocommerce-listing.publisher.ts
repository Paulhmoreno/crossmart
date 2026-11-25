import { Injectable } from '@nestjs/common';
import type { ChannelSession } from '../../sdk/auth/channel-session.js';
import type {
  ItemSpecific,
  ListingDraft,
  ListingDraftVariant,
  ListingPublisher,
  ListingReference,
  PriceUpdate,
  PublishedListing,
} from '../../sdk/capabilities/listing-publisher.js';
import type { ChannelCategory } from '../../sdk/capabilities/taxonomy-provider.js';
import { ChannelType } from '../../sdk/channel-type.enum.js';
import { ChannelError } from '../../sdk/errors/channel-error.js';
import { ChannelErrorCode } from '../../sdk/errors/channel-error-code.enum.js';
import { HttpMethod } from '../../sdk/http/http-method.enum.js';
import { PublishRequirement } from '../../sdk/publishing/publish-requirement.enum.js';
import { type WooCommerceAccount, wooCommerceAccount } from '../account/woocommerce-credentials.js';
import { WooCommerceApiClient } from '../api/woocommerce-api.client.js';
import type {
  WooMetaEntry,
  WooProduct,
  WooProductAttribute,
  WooTagRef,
  WooVariation,
} from '../api/woocommerce-api.types.js';
import { WooCommerceTaxonomyProvider } from '../taxonomy/woocommerce-taxonomy.provider.js';
import {
  WOOCOMMERCE_INVENTORY_ID_SEPARATOR,
  WOOCOMMERCE_MAX_TAGS,
  WOOCOMMERCE_META_MEDIA_MAP,
  WOOCOMMERCE_META_PRODUCT_ID,
  WOOCOMMERCE_SHORT_DESCRIPTION_KEYS,
  WOOCOMMERCE_SHORT_DESCRIPTION_MAX_LENGTH,
} from '../woocommerce.constants.js';
import { wooCommerceError } from '../woocommerce-errors.js';
import { readRemoteMediaMap, WooCommerceMediaUploader } from './woocommerce-media.uploader.js';

const GRAMS_PER_KG = 1000;
const GRAMS_PER_LB = 453.59237;
const GRAMS_PER_OZ = 28.349523125;
const WEIGHT_DECIMALS = 3;

function formatWooWeight(weightGrams: number | null, unit: string): string | undefined {
  if (weightGrams === null || weightGrams <= 0) return undefined;
  let converted: number;
  switch (unit.toLowerCase()) {
    case 'g':
      converted = weightGrams;
      break;
    case 'lbs':
      converted = weightGrams / GRAMS_PER_LB;
      break;
    case 'oz':
      converted = weightGrams / GRAMS_PER_OZ;
      break;
    default:
      converted = weightGrams / GRAMS_PER_KG;
      break;
  }
  return Number(converted.toFixed(WEIGHT_DECIMALS)).toString();
}

function resolveWooPrices(
  price: string,
  compareAtPrice: string | null,
): { regular_price: string; sale_price: string } {
  const numericPrice = Number(price);
  const numericCompare = compareAtPrice ? Number(compareAtPrice) : Number.NaN;
  if (
    Number.isFinite(numericCompare) &&
    Number.isFinite(numericPrice) &&
    numericCompare > numericPrice
  ) {
    return { regular_price: compareAtPrice!, sale_price: price };
  }
  return { regular_price: price, sale_price: '' };
}

function toTagSlug(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'tag'
  );
}

function stripHtmlSummary(html: string): string {
  const plain = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length <= WOOCOMMERCE_SHORT_DESCRIPTION_MAX_LENGTH) return plain;
  return `${plain.slice(0, WOOCOMMERCE_SHORT_DESCRIPTION_MAX_LENGTH - 1).trimEnd()}…`;
}

function extractShortDescription(draft: ListingDraft): string {
  const specific = (draft.itemSpecifics ?? []).find((item) =>
    WOOCOMMERCE_SHORT_DESCRIPTION_KEYS.has(item.name.trim().toLowerCase()),
  );
  const override = specific?.values.find((value) => value.trim().length > 0)?.trim();
  if (override) return override;
  return stripHtmlSummary(draft.product.descriptionHtml);
}

function buildAttributes(
  optionNames: readonly string[],
  variants: readonly ListingDraftVariant[],
  itemSpecifics: readonly ItemSpecific[] | undefined,
): WooProductAttribute[] {
  const result: WooProductAttribute[] = [];
  const usedNames = new Set<string>();

  if (optionNames.length > 0 && variants.length > 0) {
    for (const [index, optionName] of optionNames.entries()) {
      const options = [
        ...new Set(
          variants
            .map((variant) => variant.optionValues[index]?.trim() ?? '')
            .filter((value) => value.length > 0),
        ),
      ];
      if (options.length === 0) continue;
      usedNames.add(optionName.trim().toLowerCase());
      result.push({
        name: optionName.trim(),
        position: result.length,
        visible: true,
        variation: true,
        options,
      });
    }
  }

  for (const specific of itemSpecifics ?? []) {
    const normalized = specific.name.trim().toLowerCase();
    if (
      !normalized ||
      WOOCOMMERCE_SHORT_DESCRIPTION_KEYS.has(normalized) ||
      usedNames.has(normalized)
    ) {
      continue;
    }
    const values = specific.values.map((value) => value.trim()).filter(Boolean);
    if (values.length === 0) continue;
    usedNames.add(normalized);
    result.push({
      name: specific.name.trim(),
      position: result.length,
      visible: true,
      variation: false,
      options: values,
    });
  }

  return result;
}

function hasMatchingOwnership(
  metaData: readonly WooMetaEntry[] | undefined,
  productId: string,
): boolean {
  return Boolean(
    metaData?.some(
      (entry) => entry.key === WOOCOMMERCE_META_PRODUCT_ID && entry.value === productId,
    ),
  );
}

function isVariableDraft(draft: ListingDraft): boolean {
  return draft.product.optionNames.length > 0 || draft.variants.length > 1;
}

/**
 * Publishes and updates simple and variable products in WooCommerce REST API v3:
 * - Guards against duplicating or silently overwriting unlinked remote SKUs.
 * - Transfers photos via WordPress Media API / public HTTPS with remote ID reuse.
 * - Verifies remote persisted product and images after write.
 * - Delists safely by switching status to `draft` (never deleting).
 */
@Injectable()
export class WooCommerceListingPublisher implements ListingPublisher {
  constructor(
    private readonly api: WooCommerceApiClient,
    private readonly media: WooCommerceMediaUploader,
    private readonly taxonomy: WooCommerceTaxonomyProvider,
  ) {}

  async publish(session: ChannelSession, draft: ListingDraft): Promise<PublishedListing> {
    const { account } = await wooCommerceAccount(session);
    const variable = isVariableDraft(draft);
    const primarySku = variable ? null : draft.variants[0]?.sku?.trim() || null;

    // Prevent silent duplicate creation or hijacking an existing unlinked WooCommerce SKU
    if (primarySku) {
      const conflict = await this.findBySku(account, primarySku);
      if (conflict && !hasMatchingOwnership(conflict.meta_data, draft.productId)) {
        throw wooCommerceError(
          ChannelErrorCode.RequestRejected,
          `Ya existe un producto en WooCommerce con SKU "${primarySku}" (ID #${conflict.id}). Importa el catálogo de la tienda para vincularlo antes de actualizarlo.`,
        );
      }
      if (conflict && hasMatchingOwnership(conflict.meta_data, draft.productId)) {
        return this.update(session, String(conflict.id), draft);
      }
    }

    const category = await this.resolveCategory(account, draft);
    const tagRefs = await this.resolveTags(account, draft.product.tags);
    const resolvedMedia = await this.media.resolveImages(
      account,
      draft.product.images,
      draft.product.title,
      {},
    );

    const payload = this.buildProductPayload({
      account,
      draft,
      variable,
      category,
      tagRefs,
      images: resolvedMedia.images,
      mediaMap: resolvedMedia.mediaMap,
      status: account.defaultStatus,
    });

    const created = (
      await this.api.request<WooProduct>(account, HttpMethod.Post, '/products', payload)
    ).data;
    const syncedMediaMap = this.captureReturnedMediaIds(
      draft.product.images,
      created.images ?? [],
      resolvedMedia.mediaMap,
    );
    if (Object.keys(syncedMediaMap).length > Object.keys(resolvedMedia.mediaMap).length) {
      await this.persistMediaMap(account, created.id, draft.productId, syncedMediaMap);
    }

    const variants = variable
      ? await this.syncVariations(account, created.id, draft)
      : [
          {
            variantId: draft.variants[0].variantId,
            externalId: String(created.id),
            externalInventoryId: String(created.id),
          },
        ];

    const observed = await this.verifyPersistedProduct(
      account,
      created.id,
      draft.product.images.length,
    );
    return {
      externalId: String(observed.id),
      externalUrl: observed.permalink?.trim() || null,
      active: observed.status === 'publish',
      variants,
      category,
    };
  }

  async update(
    session: ChannelSession,
    externalId: string,
    draft: ListingDraft,
  ): Promise<PublishedListing> {
    const { account } = await wooCommerceAccount(session);
    const productId = Number(externalId);
    if (!Number.isInteger(productId) || productId <= 0) {
      throw wooCommerceError(
        ChannelErrorCode.RequestRejected,
        `ID de WooCommerce inválido: ${externalId}`,
      );
    }

    const existing = (
      await this.api.request<WooProduct>(account, HttpMethod.Get, `/products/${productId}`)
    ).data;
    const existingMediaMap = readRemoteMediaMap(existing.meta_data);
    const variable = isVariableDraft(draft);
    const category = await this.resolveCategory(account, draft);
    const tagRefs = await this.resolveTags(account, draft.product.tags);

    const shouldSendImages = draft.imagesChanged !== false || (existing.images?.length ?? 0) === 0;
    const resolvedMedia = shouldSendImages
      ? await this.media.resolveImages(
          account,
          draft.product.images,
          draft.product.title,
          existingMediaMap,
        )
      : { images: undefined, mediaMap: existingMediaMap };

    const payload = this.buildProductPayload({
      account,
      draft,
      variable,
      category,
      tagRefs,
      images: resolvedMedia.images,
      mediaMap: resolvedMedia.mediaMap,
      status: existing.status === 'trash' ? account.defaultStatus : existing.status,
    });

    const updated = (
      await this.api.request<WooProduct>(account, HttpMethod.Put, `/products/${productId}`, payload)
    ).data;

    if (shouldSendImages) {
      const syncedMediaMap = this.captureReturnedMediaIds(
        draft.product.images,
        updated.images ?? [],
        resolvedMedia.mediaMap,
      );
      if (Object.keys(syncedMediaMap).length > Object.keys(resolvedMedia.mediaMap).length) {
        await this.persistMediaMap(account, updated.id, draft.productId, syncedMediaMap);
      }
    }

    const variants = variable
      ? await this.syncVariations(account, updated.id, draft)
      : [
          {
            variantId: draft.variants[0].variantId,
            externalId: String(updated.id),
            externalInventoryId: String(updated.id),
          },
        ];

    const expectedImageCount = shouldSendImages
      ? draft.product.images.length
      : (existing.images?.length ?? 0);
    const observed = await this.verifyPersistedProduct(account, updated.id, expectedImageCount);

    return {
      externalId: String(observed.id),
      externalUrl: observed.permalink?.trim() || null,
      active: observed.status === 'publish',
      variants,
      category,
    };
  }

  async delist(
    session: ChannelSession,
    externalId: string,
    _reference?: ListingReference,
  ): Promise<void> {
    const { account } = await wooCommerceAccount(session);
    const productId = Number(externalId);
    if (!Number.isInteger(productId) || productId <= 0) return;
    await this.api.request<WooProduct>(account, HttpMethod.Put, `/products/${productId}`, {
      status: 'draft',
    });
  }

  async updatePrices(session: ChannelSession, updates: readonly PriceUpdate[]): Promise<void> {
    const { account } = await wooCommerceAccount(session);
    for (const update of updates) {
      const priceFields = resolveWooPrices(update.price, update.compareAtPrice);
      const isSimple = update.externalProductId === update.externalVariantId;
      const path = isSimple
        ? `/products/${update.externalProductId}`
        : `/products/${update.externalProductId}/variations/${update.externalVariantId}`;
      await this.api.request(account, HttpMethod.Put, path, priceFields);
    }
  }

  private buildProductPayload(params: {
    account: WooCommerceAccount;
    draft: ListingDraft;
    variable: boolean;
    category: ChannelCategory | null;
    tagRefs: WooTagRef[];
    images: { id?: number; src?: string; alt?: string }[] | undefined;
    mediaMap: Record<string, number>;
    status: string;
  }): Record<string, unknown> {
    const { account, draft, variable, category, tagRefs, images, mediaMap, status } = params;
    const primary = draft.variants[0];
    const attributes = buildAttributes(
      draft.product.optionNames,
      draft.variants,
      draft.itemSpecifics,
    );

    const payload: Record<string, unknown> = {
      name: draft.product.title,
      type: variable ? 'variable' : 'simple',
      status,
      description: draft.product.descriptionHtml,
      short_description: extractShortDescription(draft),
      ...(category ? { categories: [{ id: Number(category.id) }] } : {}),
      ...(tagRefs.length > 0 ? { tags: tagRefs.map((tag) => ({ id: tag.id })) } : {}),
      ...(attributes.length > 0 ? { attributes } : {}),
      ...(images !== undefined ? { images } : {}),
      meta_data: [
        { key: WOOCOMMERCE_META_PRODUCT_ID, value: draft.productId },
        { key: WOOCOMMERCE_META_MEDIA_MAP, value: JSON.stringify(mediaMap) },
      ],
    };

    if (!variable && primary) {
      const prices = resolveWooPrices(primary.price, primary.compareAtPrice);
      const weight = formatWooWeight(primary.weightGrams, account.weightUnit);
      const available = Math.max(0, Math.floor(primary.available ?? 0));
      Object.assign(payload, {
        ...(primary.sku ? { sku: primary.sku } : {}),
        ...(primary.barcode ? { global_unique_id: primary.barcode } : {}),
        ...prices,
        tax_status: primary.taxable ? 'taxable' : 'none',
        manage_stock: primary.tracked,
        ...(primary.tracked
          ? {
              stock_quantity: available,
              stock_status: available > 0 ? 'instock' : 'outofstock',
              backorders: primary.continueSellingWhenOutOfStock ? 'yes' : 'no',
            }
          : { stock_status: 'instock' }),
        ...(weight ? { weight } : {}),
      });
    }

    return payload;
  }

  private async syncVariations(
    account: WooCommerceAccount,
    productId: number,
    draft: ListingDraft,
  ): Promise<{ variantId: string; externalId: string; externalInventoryId: string | null }[]> {
    const existingRes = await this.api.request<WooVariation[]>(
      account,
      HttpMethod.Get,
      `/products/${productId}/variations?per_page=100`,
    );
    const existingRows = Array.isArray(existingRes.data) ? existingRes.data : [];
    const existingById = new Map(existingRows.map((row) => [String(row.id), row]));
    const existingBySku = new Map(
      existingRows.flatMap((row) => (row.sku?.trim() ? [[row.sku.trim(), row] as const] : [])),
    );

    const results: { variantId: string; externalId: string; externalInventoryId: string | null }[] =
      [];
    for (const variant of draft.variants) {
      const matched =
        (variant.externalVariantId ? existingById.get(variant.externalVariantId) : undefined) ??
        (variant.sku ? existingBySku.get(variant.sku.trim()) : undefined);

      const prices = resolveWooPrices(variant.price, variant.compareAtPrice);
      const weight = formatWooWeight(variant.weightGrams, account.weightUnit);
      const available = Math.max(0, Math.floor(variant.available ?? 0));
      const attributes = draft.product.optionNames.map((name, index) => ({
        name: name.trim(),
        option: variant.optionValues[index]?.trim() ?? 'Default',
      }));

      const body: Record<string, unknown> = {
        ...(variant.sku ? { sku: variant.sku } : {}),
        ...(variant.barcode ? { global_unique_id: variant.barcode } : {}),
        ...prices,
        tax_status: variant.taxable ? 'taxable' : 'none',
        manage_stock: variant.tracked,
        ...(variant.tracked
          ? {
              stock_quantity: available,
              stock_status: available > 0 ? 'instock' : 'outofstock',
              backorders: variant.continueSellingWhenOutOfStock ? 'yes' : 'no',
            }
          : { stock_status: 'instock' }),
        ...(weight ? { weight } : {}),
        attributes,
      };

      const saved = matched
        ? (
            await this.api.request<WooVariation>(
              account,
              HttpMethod.Put,
              `/products/${productId}/variations/${matched.id}`,
              body,
            )
          ).data
        : (
            await this.api.request<WooVariation>(
              account,
              HttpMethod.Post,
              `/products/${productId}/variations`,
              body,
            )
          ).data;

      results.push({
        variantId: variant.variantId,
        externalId: String(saved.id),
        externalInventoryId: `${productId}${WOOCOMMERCE_INVENTORY_ID_SEPARATOR}${saved.id}`,
      });
    }
    return results;
  }

  private async verifyPersistedProduct(
    account: WooCommerceAccount,
    productId: number,
    expectedImageCount: number,
  ): Promise<WooProduct> {
    const observed = (
      await this.api.request<WooProduct>(account, HttpMethod.Get, `/products/${productId}`)
    ).data;
    const actualCount = observed.images?.length ?? 0;
    if (expectedImageCount > 0 && actualCount < expectedImageCount) {
      throw new ChannelError(
        ChannelType.WooCommerce,
        ChannelErrorCode.RequestRejected,
        `WooCommerce solo confirmó ${actualCount} de ${expectedImageCount} fotografías en el producto #${productId}. Revisa los permisos multimedia de WordPress.`,
        PublishRequirement.Images,
      );
    }
    return observed;
  }

  private captureReturnedMediaIds(
    sourceImages: readonly { url: string }[],
    remoteImages: readonly { id?: number }[],
    currentMap: Record<string, number>,
  ): Record<string, number> {
    if (sourceImages.length !== remoteImages.length) return currentMap;
    const next = { ...currentMap };
    for (const [index, source] of sourceImages.entries()) {
      const remoteId = remoteImages[index]?.id;
      if (remoteId && Number.isInteger(remoteId) && remoteId > 0) {
        next[source.url] = remoteId;
      }
    }
    return next;
  }

  private async persistMediaMap(
    account: WooCommerceAccount,
    productId: number,
    crossmartProductId: string,
    mediaMap: Record<string, number>,
  ): Promise<void> {
    try {
      await this.api.request(account, HttpMethod.Put, `/products/${productId}`, {
        meta_data: [
          { key: WOOCOMMERCE_META_PRODUCT_ID, value: crossmartProductId },
          { key: WOOCOMMERCE_META_MEDIA_MAP, value: JSON.stringify(mediaMap) },
        ],
      });
    } catch {
      // Non-fatal: images are already persisted; cache update is best-effort.
    }
  }

  private async findBySku(account: WooCommerceAccount, sku: string): Promise<WooProduct | null> {
    const response = await this.api.request<WooProduct[]>(
      account,
      HttpMethod.Get,
      `/products?sku=${encodeURIComponent(sku)}&status=any`,
    );
    const list = Array.isArray(response.data) ? response.data : [];
    return list.find((item) => item.status !== 'trash') ?? null;
  }

  private async resolveCategory(
    account: WooCommerceAccount,
    draft: ListingDraft,
  ): Promise<ChannelCategory | null> {
    if (draft.category?.id && Number(draft.category.id) > 0) {
      return draft.category;
    }
    return this.taxonomy.findReliableCategoryMatch(account, draft.product.productType);
  }

  private async resolveTags(
    account: WooCommerceAccount,
    tags: readonly string[],
  ): Promise<WooTagRef[]> {
    const unique = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].slice(
      0,
      WOOCOMMERCE_MAX_TAGS,
    );
    const resolved: WooTagRef[] = [];
    for (const name of unique) {
      const slug = toTagSlug(name);
      const existing = await this.findTagBySlug(account, slug);
      if (existing) {
        resolved.push(existing);
        continue;
      }
      try {
        const created = (
          await this.api.request<WooTagRef>(account, HttpMethod.Post, '/products/tags', {
            name,
            slug,
          })
        ).data;
        if (created?.id) resolved.push(created);
      } catch {
        const retry = await this.findTagBySlug(account, slug);
        if (retry) resolved.push(retry);
      }
    }
    return resolved;
  }

  private async findTagBySlug(
    account: WooCommerceAccount,
    slug: string,
  ): Promise<WooTagRef | null> {
    const response = await this.api.request<WooTagRef[]>(
      account,
      HttpMethod.Get,
      `/products/tags?slug=${encodeURIComponent(slug)}`,
    );
    const rows = Array.isArray(response.data) ? response.data : [];
    return rows[0] ?? null;
  }
}
