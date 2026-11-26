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
import { ChannelErrorCode } from '../../sdk/errors/channel-error-code.enum.js';
import { HttpMethod } from '../../sdk/http/http-method.enum.js';
import { type WooCommerceAccount, wooCommerceAccount } from '../account/woocommerce-credentials.js';
import { WooCommerceApiClient } from '../api/woocommerce-api.client.js';
import type {
  WooAttribute,
  WooMetaEntry,
  WooProduct,
  WooProductAttribute,
  WooTagRef,
  WooVariation,
} from '../api/woocommerce-api.types.js';
import {
  normalizeExactTermName,
  toWooSlug,
  WooCommerceTaxonomyProvider,
} from '../taxonomy/woocommerce-taxonomy.provider.js';
import {
  WOOCOMMERCE_INVENTORY_ID_SEPARATOR,
  WOOCOMMERCE_MAX_TAGS,
  WOOCOMMERCE_MAX_VARIATION_PAGES,
  WOOCOMMERCE_META_AUTO_CATEGORY_ID,
  WOOCOMMERCE_META_MANAGED_ATTRIBUTES,
  WOOCOMMERCE_META_MANAGED_BRAND,
  WOOCOMMERCE_META_MANAGED_TAGS,
  WOOCOMMERCE_META_MEDIA_MAP,
  WOOCOMMERCE_META_PRODUCT_ID,
  WOOCOMMERCE_SHORT_DESCRIPTION_KEYS,
  WOOCOMMERCE_SHORT_DESCRIPTION_MAX_LENGTH,
  WOOCOMMERCE_VARIATIONS_PAGE_SIZE,
} from '../woocommerce.constants.js';
import { wooCommerceError } from '../woocommerce-errors.js';
import { readRemoteMediaMap, WooCommerceMediaUploader } from './woocommerce-media.uploader.js';
import {
  assertPersistedWooProduct,
  type ExpectedPersistedVariant,
} from './woocommerce-product.verifier.js';

const GRAMS_PER_KG = 1000;
const GRAMS_PER_LB = 453.59237;
const GRAMS_PER_OZ = 28.349523125;
const WEIGHT_DECIMALS = 3;
const FIRST_PAGE = 1;

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

function resolveStockStatus(available: number, continueSellingWhenOutOfStock: boolean): string {
  if (available > 0) return 'instock';
  return continueSellingWhenOutOfStock ? 'onbackorder' : 'outofstock';
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

function readMetaString(metaData: readonly WooMetaEntry[] | undefined, key: string): string | null {
  const entry = metaData?.find((item) => item.key === key);
  return typeof entry?.value === 'string' && entry.value.trim().length > 0
    ? entry.value.trim()
    : null;
}

function readMetaNumberSet(
  metaData: readonly WooMetaEntry[] | undefined,
  key: string,
): Set<number> {
  const raw = readMetaString(metaData, key);
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter(
        (val): val is number => typeof val === 'number' && Number.isInteger(val) && val > 0,
      ),
    );
  } catch {
    return new Set();
  }
}

function readMetaStringSet(
  metaData: readonly WooMetaEntry[] | undefined,
  key: string,
): Set<string> {
  const raw = readMetaString(metaData, key);
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter((val): val is string => typeof val === 'string' && val.trim().length > 0),
    );
  } catch {
    return new Set();
  }
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

function optionSignature(optionValues: readonly string[]): string {
  return optionValues.map((value) => normalizeExactTermName(value)).join('|');
}

function variationOptionSignature(variation: WooVariation, optionNames: readonly string[]): string {
  const byName = new Map(
    variation.attributes.map((attr) => [
      normalizeExactTermName(attr.name),
      normalizeExactTermName(attr.option),
    ]),
  );
  return optionNames.map((name) => byName.get(normalizeExactTermName(name)) ?? '').join('|');
}

interface ResolvedAttributesResult {
  attributes: WooProductAttribute[] | null;
  managedNames: string[];
  globalIdByName: Map<string, number>;
}

/**
 * Publishes and updates simple and variable products in WooCommerce REST API v3:
 * - Resolves hierarchical categories from Odoo paths without duplicating or flattening.
 * - Resolves native WooCommerce brands (`/products/brands`) without substituting with tags.
 * - Resolves tags and global attributes strictly without silently omitting rejections,
 *   preserving foreign remote metadata while supporting explicit removals.
 * - Guards against duplicating or overwriting unlinked remote SKUs (simple & variable).
 * - Paginates all variations and verifies every sent field on read-back.
 * - Never auto-promotes drafts to public status; delists safely to `draft`.
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

    // Guard against duplicate creation or hijacking unlinked remote SKUs (simple & variable)
    const recoveredId = await this.checkSkuConflictsOrRecover(account, draft, variable);
    if (recoveredId !== null) {
      return this.update(session, String(recoveredId), draft);
    }

    const { category, autoCategoryId } = await this.resolveCategory(account, draft, null);
    const { brandId, managedBrandMeta } = await this.resolveBrand(account, draft, null);
    const tagRefs = await this.resolveTags(account, draft.product.tags);
    const managedTagIds = tagRefs.map((tag) => tag.id);
    const resolvedAttrs = await this.resolveAttributes(account, draft, null);
    const resolvedMedia = await this.media.resolveImages(
      account,
      draft.product.images,
      draft.product.title,
      {},
    );
    const targetStatus = this.resolveInitialStatus(account, draft);
    const shortDescription = extractShortDescription(draft);

    const payload = this.buildProductPayload({
      account,
      draft,
      variable,
      category,
      autoCategoryId,
      brandIds: brandId !== null ? [brandId] : null,
      managedBrandMeta,
      tagIds: managedTagIds.length > 0 ? managedTagIds : null,
      managedTagIds,
      attributes: resolvedAttrs.attributes,
      managedAttributeNames: resolvedAttrs.managedNames,
      images: resolvedMedia.images,
      mediaMap: resolvedMedia.mediaMap,
      status: targetStatus,
      shortDescription,
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

    const syncedVariants = variable
      ? await this.syncVariations(account, created.id, draft, resolvedAttrs.globalIdByName)
      : {
          mappings: [
            {
              variantId: draft.variants[0].variantId,
              externalId: String(created.id),
              externalInventoryId: String(created.id),
            },
          ],
          expected: [] as ExpectedPersistedVariant[],
        };

    const observed = await this.verifyPersistedProduct(account, created.id, {
      draft,
      variable,
      status: targetStatus,
      shortDescription,
      categoryId: category ? Number(category.id) : null,
      brandId,
      tagIds: managedTagIds.length > 0 ? managedTagIds : null,
      removedTagIds: [],
      attributes: resolvedAttrs.attributes,
      expectedImages: resolvedMedia.images,
      expectedImageCount: draft.product.images.length,
      expectedVariants: syncedVariants.expected,
    });

    return {
      externalId: String(observed.id),
      externalUrl: observed.permalink?.trim() || null,
      active: observed.status === 'publish',
      variants: syncedVariants.mappings,
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

    const { category, autoCategoryId } = await this.resolveCategory(account, draft, existing);
    const { brandId, brandIdsToSend, managedBrandMeta } = await this.resolveBrand(
      account,
      draft,
      existing,
    );
    const tagRefs = await this.resolveTags(account, draft.product.tags);
    const { tagIdsToSend, managedTagIds, removedTagIds } = this.mergeTags(tagRefs, existing);
    const resolvedAttrs = await this.resolveAttributes(account, draft, existing);

    const shouldSendImages = draft.imagesChanged !== false || (existing.images?.length ?? 0) === 0;
    const resolvedMedia = shouldSendImages
      ? await this.media.resolveImages(
          account,
          draft.product.images,
          draft.product.title,
          existingMediaMap,
        )
      : { images: undefined, mediaMap: existingMediaMap };

    const targetStatus = this.resolveUpdateStatus(account, draft, existing.status);
    const shortDescription = extractShortDescription(draft);

    const payload = this.buildProductPayload({
      account,
      draft,
      variable,
      category,
      autoCategoryId,
      brandIds: brandIdsToSend,
      managedBrandMeta,
      tagIds: tagIdsToSend,
      managedTagIds,
      attributes: resolvedAttrs.attributes,
      managedAttributeNames: resolvedAttrs.managedNames,
      images: resolvedMedia.images,
      mediaMap: resolvedMedia.mediaMap,
      status: targetStatus,
      shortDescription,
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

    const syncedVariants = variable
      ? await this.syncVariations(account, updated.id, draft, resolvedAttrs.globalIdByName)
      : {
          mappings: [
            {
              variantId: draft.variants[0].variantId,
              externalId: String(updated.id),
              externalInventoryId: String(updated.id),
            },
          ],
          expected: [] as ExpectedPersistedVariant[],
        };

    const expectedImageCount = shouldSendImages
      ? draft.product.images.length
      : (existing.images?.length ?? 0);
    const observed = await this.verifyPersistedProduct(account, updated.id, {
      draft,
      variable,
      status: targetStatus,
      shortDescription,
      categoryId: category ? Number(category.id) : null,
      brandId,
      tagIds: tagIdsToSend,
      removedTagIds,
      attributes: resolvedAttrs.attributes,
      expectedImages: resolvedMedia.images ?? null,
      expectedImageCount,
      expectedVariants: syncedVariants.expected,
    });

    return {
      externalId: String(observed.id),
      externalUrl: observed.permalink?.trim() || null,
      active: observed.status === 'publish',
      variants: syncedVariants.mappings,
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

  private resolveInitialStatus(account: WooCommerceAccount, draft: ListingDraft): string {
    if (draft.explicitVisibility === 'hidden') return 'draft';
    if (draft.explicitVisibility === 'visible') return 'publish';
    return account.defaultStatus === 'publish' && draft.product.active ? 'publish' : 'draft';
  }

  private resolveUpdateStatus(
    account: WooCommerceAccount,
    draft: ListingDraft,
    existingStatus: string,
  ): string {
    if (draft.explicitVisibility === 'hidden') return 'draft';
    if (draft.explicitVisibility === 'visible') return 'publish';
    // Never auto-promote an existing WooCommerce draft to publish on content updates.
    return existingStatus === 'trash' ? account.defaultStatus : existingStatus;
  }

  private async checkSkuConflictsOrRecover(
    account: WooCommerceAccount,
    draft: ListingDraft,
    variable: boolean,
  ): Promise<number | null> {
    const skus = variable
      ? [
          ...new Set(
            draft.variants.map((variant) => variant.sku?.trim()).filter(Boolean) as string[],
          ),
        ]
      : [draft.variants[0]?.sku?.trim()].filter((sku): sku is string => Boolean(sku));

    for (const sku of skus) {
      const conflict = await this.findBySku(account, sku);
      if (!conflict) continue;
      if (hasMatchingOwnership(conflict.meta_data, draft.productId)) {
        return conflict.id;
      }
      throw wooCommerceError(
        ChannelErrorCode.RequestRejected,
        `Ya existe un producto en WooCommerce con SKU "${sku}" (ID #${conflict.id}). Importa el catálogo de la tienda para vincularlo antes de actualizarlo.`,
      );
    }
    return null;
  }

  private async resolveCategory(
    account: WooCommerceAccount,
    draft: ListingDraft,
    existing: WooProduct | null,
  ): Promise<{ category: ChannelCategory | null; autoCategoryId: string | null }> {
    const prevAutoId = readMetaString(existing?.meta_data, WOOCOMMERCE_META_AUTO_CATEGORY_ID);
    const hasDraftCategory = Boolean(draft.category?.id && Number(draft.category.id) > 0);
    const isExplicitManual = hasDraftCategory && draft.category!.id !== prevAutoId;

    if (isExplicitManual) {
      return { category: draft.category!, autoCategoryId: null };
    }
    if (draft.product.productType?.trim()) {
      const resolved = await this.taxonomy.resolveCategoryHierarchy(
        account,
        draft.product.productType,
      );
      if (resolved) {
        return { category: resolved, autoCategoryId: resolved.id };
      }
    }
    if (hasDraftCategory) {
      return { category: draft.category!, autoCategoryId: prevAutoId };
    }
    return { category: null, autoCategoryId: null };
  }

  private async resolveBrand(
    account: WooCommerceAccount,
    draft: ListingDraft,
    existing: WooProduct | null,
  ): Promise<{
    brandId: number | null;
    brandIdsToSend: number[] | null;
    managedBrandMeta: string;
  }> {
    const vendor = draft.product.vendor?.trim() ?? '';
    const prevManagedBrandId = readMetaString(existing?.meta_data, WOOCOMMERCE_META_MANAGED_BRAND);

    if (!vendor) {
      if (!existing || !prevManagedBrandId) {
        return { brandId: null, brandIdsToSend: null, managedBrandMeta: '' };
      }
      const foreignBrandIds = (existing.brands ?? [])
        .map((brand) => brand.id)
        .filter((id) => String(id) !== prevManagedBrandId);
      return { brandId: null, brandIdsToSend: foreignBrandIds, managedBrandMeta: '' };
    }

    const brand = await this.taxonomy.resolveBrand(account, vendor);
    const foreignBrandIds = (existing?.brands ?? [])
      .map((entry) => entry.id)
      .filter((id) => String(id) !== prevManagedBrandId && id !== brand.id);
    return {
      brandId: brand.id,
      brandIdsToSend: [...foreignBrandIds, brand.id],
      managedBrandMeta: String(brand.id),
    };
  }

  private mergeTags(
    resolvedTags: readonly WooTagRef[],
    existing: WooProduct,
  ): {
    tagIdsToSend: number[] | null;
    managedTagIds: number[];
    removedTagIds: number[];
  } {
    const prevManaged = readMetaNumberSet(existing.meta_data, WOOCOMMERCE_META_MANAGED_TAGS);
    const currentManagedIds = resolvedTags.map((tag) => tag.id);
    const currentSet = new Set(currentManagedIds);
    const removedTagIds = [...prevManaged].filter((id) => !currentSet.has(id));

    if (currentManagedIds.length === 0 && prevManaged.size === 0) {
      return { tagIdsToSend: null, managedTagIds: [], removedTagIds: [] };
    }

    const foreignIds = (existing.tags ?? [])
      .map((tag) => tag.id)
      .filter((id) => !prevManaged.has(id) && !currentSet.has(id));
    return {
      tagIdsToSend: [...foreignIds, ...currentManagedIds],
      managedTagIds: currentManagedIds,
      removedTagIds,
    };
  }

  private async resolveAttributes(
    account: WooCommerceAccount,
    draft: ListingDraft,
    existing: WooProduct | null,
  ): Promise<ResolvedAttributesResult> {
    const desired = this.collectDesiredAttributes(
      draft.product.optionNames,
      draft.variants,
      draft.itemSpecifics,
    );
    const prevManaged = readMetaStringSet(existing?.meta_data, WOOCOMMERCE_META_MANAGED_ATTRIBUTES);
    const globalIdByName = new Map<string, number>();

    if (desired.length === 0 && prevManaged.size === 0) {
      return { attributes: null, managedNames: [], globalIdByName };
    }

    const globalAttrs =
      desired.length > 0 ? await this.readGlobalAttributesSafe(account) : ([] as WooAttribute[]);
    const globalByNormalizedName = new Map(
      globalAttrs.map((attr) => [normalizeExactTermName(attr.name), attr]),
    );

    const managedAttrs: WooProductAttribute[] = [];
    const managedNames: string[] = [];
    for (const attr of desired) {
      const normName = normalizeExactTermName(attr.name);
      managedNames.push(normName);
      const globalMatch = globalByNormalizedName.get(normName);
      if (globalMatch) {
        globalIdByName.set(normName, globalMatch.id);
        await this.taxonomy.ensureAttributeTerms(account, globalMatch.id, attr.options);
        managedAttrs.push({
          id: globalMatch.id,
          name: attr.name,
          position: managedAttrs.length,
          visible: true,
          variation: attr.variation,
          options: attr.options,
        });
      } else {
        managedAttrs.push({
          name: attr.name,
          position: managedAttrs.length,
          visible: true,
          variation: attr.variation,
          options: attr.options,
        });
      }
    }

    const managedNameSet = new Set(managedNames);
    const foreignAttrs = (existing?.attributes ?? []).filter((attr) => {
      const norm = normalizeExactTermName(attr.name);
      return !prevManaged.has(norm) && !managedNameSet.has(norm);
    });

    const combined = [
      ...managedAttrs,
      ...foreignAttrs.map((attr, index) => ({ ...attr, position: managedAttrs.length + index })),
    ];

    return { attributes: combined, managedNames, globalIdByName };
  }

  private collectDesiredAttributes(
    optionNames: readonly string[],
    variants: readonly ListingDraftVariant[],
    itemSpecifics: readonly ItemSpecific[] | undefined,
  ): { name: string; variation: boolean; options: string[] }[] {
    const result: { name: string; variation: boolean; options: string[] }[] = [];
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
        const normalized = normalizeExactTermName(optionName);
        usedNames.add(normalized);
        result.push({ name: optionName.trim(), variation: true, options });
      }
    }

    for (const specific of itemSpecifics ?? []) {
      const normalized = normalizeExactTermName(specific.name);
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
      result.push({ name: specific.name.trim(), variation: false, options: values });
    }

    return result;
  }

  private async readGlobalAttributesSafe(account: WooCommerceAccount): Promise<WooAttribute[]> {
    try {
      return await this.taxonomy.listGlobalAttributes(account);
    } catch {
      return [];
    }
  }

  private buildProductPayload(params: {
    account: WooCommerceAccount;
    draft: ListingDraft;
    variable: boolean;
    category: ChannelCategory | null;
    autoCategoryId: string | null;
    brandIds: number[] | null;
    managedBrandMeta: string;
    tagIds: number[] | null;
    managedTagIds: number[];
    attributes: WooProductAttribute[] | null;
    managedAttributeNames: string[];
    images: { id?: number; src?: string; alt?: string }[] | undefined;
    mediaMap: Record<string, number>;
    status: string;
    shortDescription: string;
  }): Record<string, unknown> {
    const {
      account,
      draft,
      variable,
      category,
      autoCategoryId,
      brandIds,
      managedBrandMeta,
      tagIds,
      managedTagIds,
      attributes,
      managedAttributeNames,
      images,
      mediaMap,
      status,
      shortDescription,
    } = params;
    const primary = draft.variants[0];

    const metaData: WooMetaEntry[] = [
      { key: WOOCOMMERCE_META_PRODUCT_ID, value: draft.productId },
      { key: WOOCOMMERCE_META_MEDIA_MAP, value: JSON.stringify(mediaMap) },
      { key: WOOCOMMERCE_META_AUTO_CATEGORY_ID, value: autoCategoryId ?? '' },
      { key: WOOCOMMERCE_META_MANAGED_BRAND, value: managedBrandMeta },
      { key: WOOCOMMERCE_META_MANAGED_TAGS, value: JSON.stringify(managedTagIds) },
      { key: WOOCOMMERCE_META_MANAGED_ATTRIBUTES, value: JSON.stringify(managedAttributeNames) },
    ];

    const payload: Record<string, unknown> = {
      name: draft.product.title,
      type: variable ? 'variable' : 'simple',
      status,
      description: draft.product.descriptionHtml,
      short_description: shortDescription,
      ...(category ? { categories: [{ id: Number(category.id) }] } : {}),
      ...(brandIds !== null ? { brands: brandIds.map((id) => ({ id })) } : {}),
      ...(tagIds !== null ? { tags: tagIds.map((id) => ({ id })) } : {}),
      ...(attributes !== null ? { attributes } : {}),
      ...(images !== undefined ? { images } : {}),
      meta_data: metaData,
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
              stock_status: resolveStockStatus(available, primary.continueSellingWhenOutOfStock),
              backorders: primary.continueSellingWhenOutOfStock ? 'yes' : 'no',
            }
          : { stock_status: 'instock' }),
        ...(weight ? { weight } : {}),
      });
    }

    return payload;
  }

  private async fetchAllVariations(
    account: WooCommerceAccount,
    productId: number,
  ): Promise<WooVariation[]> {
    const all: WooVariation[] = [];
    for (let page = FIRST_PAGE; page <= WOOCOMMERCE_MAX_VARIATION_PAGES; page += 1) {
      const response = await this.api.request<WooVariation[]>(
        account,
        HttpMethod.Get,
        `/products/${productId}/variations?per_page=${WOOCOMMERCE_VARIATIONS_PAGE_SIZE}&page=${page}`,
      );
      const rows = Array.isArray(response.data) ? response.data : [];
      all.push(...rows);
      const totalPages = Number.parseInt(response.headers['x-wp-totalpages'] ?? '1', 10) || 1;
      if (rows.length < WOOCOMMERCE_VARIATIONS_PAGE_SIZE || page >= totalPages) break;
    }
    return all;
  }

  private async syncVariations(
    account: WooCommerceAccount,
    productId: number,
    draft: ListingDraft,
    globalIdByName: Map<string, number>,
  ): Promise<{
    mappings: { variantId: string; externalId: string; externalInventoryId: string | null }[];
    expected: ExpectedPersistedVariant[];
  }> {
    const existingRows = await this.fetchAllVariations(account, productId);
    const existingById = new Map(existingRows.map((row) => [String(row.id), row]));
    const existingBySku = new Map(
      existingRows.flatMap((row) => (row.sku?.trim() ? [[row.sku.trim(), row] as const] : [])),
    );
    const existingByOptions = new Map(
      existingRows.map((row) => [variationOptionSignature(row, draft.product.optionNames), row]),
    );

    const mappings: {
      variantId: string;
      externalId: string;
      externalInventoryId: string | null;
    }[] = [];
    const expected: ExpectedPersistedVariant[] = [];

    for (const variant of draft.variants) {
      const matched =
        (variant.externalVariantId ? existingById.get(variant.externalVariantId) : undefined) ??
        (variant.sku ? existingBySku.get(variant.sku.trim()) : undefined) ??
        existingByOptions.get(optionSignature(variant.optionValues));

      const prices = resolveWooPrices(variant.price, variant.compareAtPrice);
      const weight = formatWooWeight(variant.weightGrams, account.weightUnit);
      const available = Math.max(0, Math.floor(variant.available ?? 0));
      const stockStatus = variant.tracked
        ? resolveStockStatus(available, variant.continueSellingWhenOutOfStock)
        : 'instock';
      const attributes = draft.product.optionNames.map((name, index) => {
        const globalId = globalIdByName.get(normalizeExactTermName(name));
        return {
          ...(globalId ? { id: globalId } : { name: name.trim() }),
          option: variant.optionValues[index]?.trim() ?? 'Default',
        };
      });

      const body: Record<string, unknown> = {
        ...(variant.sku ? { sku: variant.sku } : {}),
        ...(variant.barcode ? { global_unique_id: variant.barcode } : {}),
        ...prices,
        tax_status: variant.taxable ? 'taxable' : 'none',
        manage_stock: variant.tracked,
        ...(variant.tracked
          ? {
              stock_quantity: available,
              stock_status: stockStatus,
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

      mappings.push({
        variantId: variant.variantId,
        externalId: String(saved.id),
        externalInventoryId: `${productId}${WOOCOMMERCE_INVENTORY_ID_SEPARATOR}${saved.id}`,
      });
      expected.push({
        externalId: String(saved.id),
        sku: variant.sku?.trim() || null,
        barcode: variant.barcode?.trim() || null,
        regularPrice: prices.regular_price,
        salePrice: prices.sale_price,
        tracked: variant.tracked,
        stockQuantity: variant.tracked ? available : null,
        stockStatus,
      });
    }
    return { mappings, expected };
  }

  private async verifyPersistedProduct(
    account: WooCommerceAccount,
    productId: number,
    check: {
      draft: ListingDraft;
      variable: boolean;
      status: string;
      shortDescription: string;
      categoryId: number | null;
      brandId: number | null;
      tagIds: readonly number[] | null;
      removedTagIds: readonly number[];
      attributes: readonly WooProductAttribute[] | null;
      expectedImages: { id?: number; src?: string; alt?: string }[] | null;
      expectedImageCount: number;
      expectedVariants: readonly ExpectedPersistedVariant[];
    },
  ): Promise<WooProduct> {
    const observed = (
      await this.api.request<WooProduct>(account, HttpMethod.Get, `/products/${productId}`)
    ).data;
    const observedVariations = check.variable
      ? await this.fetchAllVariations(account, productId)
      : [];

    const primary = check.draft.variants[0];
    const simplePrices =
      !check.variable && primary ? resolveWooPrices(primary.price, primary.compareAtPrice) : null;
    const simpleAvailable =
      !check.variable && primary ? Math.max(0, Math.floor(primary.available ?? 0)) : 0;

    assertPersistedWooProduct(
      {
        productId: check.draft.productId,
        name: check.draft.product.title,
        description: check.draft.product.descriptionHtml,
        shortDescription: check.shortDescription,
        status: check.status,
        variable: check.variable,
        categoryId: check.categoryId,
        brandId: check.brandId,
        tagIds: check.tagIds,
        removedTagIds: check.removedTagIds,
        attributes: check.attributes,
        expectedImages: check.expectedImages as never,
        expectedImageCount: check.expectedImageCount,
        ...(simplePrices && primary
          ? {
              simple: {
                sku: primary.sku?.trim() || null,
                barcode: primary.barcode?.trim() || null,
                regularPrice: simplePrices.regular_price,
                salePrice: simplePrices.sale_price,
                tracked: primary.tracked,
                stockQuantity: primary.tracked ? simpleAvailable : null,
                stockStatus: primary.tracked
                  ? resolveStockStatus(simpleAvailable, primary.continueSellingWhenOutOfStock)
                  : 'instock',
              },
            }
          : {}),
        ...(check.variable ? { variants: check.expectedVariants } : {}),
      },
      observed,
      observedVariations,
    );

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
      const term = await this.taxonomy.resolveTerm(account, 'tags', name, toWooSlug(name));
      resolved.push({ id: term.id, name: term.name, slug: term.slug });
    }
    return resolved;
  }
}
