import { Injectable } from '@nestjs/common';
import type { ListingDraftVariant } from '../../sdk/capabilities/listing-publisher.js';
import { MercadoLibreItemStatus } from '../mercadolibre.enums.js';
import {
  identifierAttributes,
  optionAttributes,
  productAttributes,
} from './mercadolibre-attributes.js';
import { MercadoLibreCatalogMatcher } from './mercadolibre-catalog.matcher.js';
import { MercadoLibreItemClient } from './mercadolibre-item.client.js';
import { MercadoLibreItemLifecycle } from './mercadolibre-item-lifecycle.js';
import { MercadoLibreItemVerifier } from './mercadolibre-item.verifier.js';
import {
  changedPictures,
  listedQuantity,
  listingPictures,
  mercadoLibreDescription,
  mercadoLibrePrice,
  mercadoLibreTitle,
  newItemTerms,
} from './mercadolibre-item.mapper.js';
import type { MercadoLibreItem, MercadoLibreItemInput } from './mercadolibre-item.types.js';
import { formatVariantKey } from './mercadolibre-keys.js';
import type {
  MercadoLibreListingOutcome,
  MercadoLibreListingPlan,
  MercadoLibreListingWriter,
} from './mercadolibre-listing-plan.js';
import { sharedPrice, toVariation, variationKeys } from './mercadolibre-variations.mapper.js';

function totalQuantity(plan: MercadoLibreListingPlan): number {
  return plan.draft.variants.reduce((total, variant) => total + listedQuantity(variant), 0);
}

function hasVariations(plan: MercadoLibreListingPlan): boolean {
  return plan.draft.variants.length > 1;
}

/** A single variant's own price, stock and attributes, on an item without variations. */
function singleVariantFields(
  plan: MercadoLibreListingPlan,
  variant: ListingDraftVariant,
): MercadoLibreItemInput {
  return {
    price: mercadoLibrePrice(variant.price, plan.settings),
    available_quantity: listedQuantity(variant),
    ...(variant.sku ? { seller_custom_field: variant.sku } : {}),
    attributes: [
      ...productAttributes(plan.draft, plan.attributes),
      ...optionAttributes(plan.draft, variant, plan.attributes),
      ...identifierAttributes(variant, plan.attributes),
    ],
  };
}

/** The price and stock of the item: its variations, or its only variant's. */
function stockFields(plan: MercadoLibreListingPlan): MercadoLibreItemInput {
  const [variant] = plan.draft.variants;
  if (!hasVariations(plan) && variant) return singleVariantFields(plan, variant);
  const price = sharedPrice(plan);
  return {
    price,
    available_quantity: totalQuantity(plan),
    attributes: productAttributes(plan.draft, plan.attributes),
    variations: plan.draft.variants.map((each) => toVariation(plan, each, price)),
  };
}

function isOwnedOpenSkuMatch(item: MercadoLibreItem, userId: string, sku: string): boolean {
  if (item.status === MercadoLibreItemStatus.Closed) return false;
  if (item.seller_id !== undefined && String(item.seller_id) !== userId) return false;
  if (item.seller_custom_field === sku) return true;
  return item.attributes.some((attr) => attr.id === 'SELLER_SKU' && attr.value_name === sku);
}

/**
 * Lists a product as one item, its variants as the item's variations (sellers without User
 * Products): recovers existing own open SKU before creating, pre-validates with
 * `POST /items/validate`, creates/updates, writes description, and reads back to verify.
 */
@Injectable()
export class MercadoLibreSingleItemWriter implements MercadoLibreListingWriter {
  constructor(
    private readonly items: MercadoLibreItemClient,
    private readonly lifecycle: MercadoLibreItemLifecycle,
    private readonly catalog: MercadoLibreCatalogMatcher,
    private readonly verifier: MercadoLibreItemVerifier,
  ) {}

  async publish(plan: MercadoLibreListingPlan): Promise<MercadoLibreListingOutcome> {
    const recoveredId = await this.recoverOwnItemBySku(plan);
    if (recoveredId) return this.update(plan, recoveredId);
    const body = await this.buildCreatePayload(plan);
    await this.items.assertValid(plan.accessToken, body);
    const created = await this.items.create(plan.accessToken, body);
    await this.items.addDescription(
      plan.accessToken,
      created.id,
      mercadoLibreDescription(plan.draft),
    );
    return this.outcome(plan, created);
  }

  async update(plan: MercadoLibreListingPlan, itemId: string): Promise<MercadoLibreListingOutcome> {
    const { accessToken, draft } = plan;
    const current = await this.lifecycle.requireOpen(accessToken, itemId);
    const updated = await this.items.update(accessToken, itemId, {
      ...(current.sold_quantity === 0
        ? { title: mercadoLibreTitle(draft, plan.categoryDetails) }
        : {}),
      ...changedPictures(draft, plan.pictures),
      ...stockFields(plan),
    });
    await this.items.replaceDescription(accessToken, itemId, mercadoLibreDescription(draft));
    return this.outcome(plan, updated);
  }

  private async buildCreatePayload(plan: MercadoLibreListingPlan): Promise<MercadoLibreItemInput> {
    const { accessToken, draft, settings, category, categoryDetails } = plan;
    const [singleVariant] = draft.variants;
    const catalogProductId =
      !hasVariations(plan) && singleVariant
        ? await this.catalog.findExactByGtin(accessToken, settings.siteId, singleVariant.barcode)
        : null;
    return {
      ...newItemTerms(draft, settings, category.id, categoryDetails),
      title: mercadoLibreTitle(draft, categoryDetails),
      pictures: plan.pictures ?? listingPictures(draft, categoryDetails),
      ...(catalogProductId ? { catalog_product_id: catalogProductId } : {}),
      ...stockFields(plan),
    };
  }

  /** Recovers an unambiguous own open item with exact SKU to avoid duplicates after partial failure. */
  private async recoverOwnItemBySku(plan: MercadoLibreListingPlan): Promise<string | null> {
    if (hasVariations(plan)) return null;
    const sku = plan.draft.variants[0]?.sku?.trim();
    if (!sku) return null;
    try {
      const ids = await this.items.searchOwnItemsBySku(plan.accessToken, plan.settings.userId, sku);
      if (ids.length !== 1 || !ids[0]) return null;
      const candidate = await this.items.find(plan.accessToken, ids[0]);
      if (!candidate) return null;
      return isOwnedOpenSkuMatch(candidate, plan.settings.userId, sku) ? candidate.id : null;
    } catch {
      return null;
    }
  }

  private async outcome(
    plan: MercadoLibreListingPlan,
    item: MercadoLibreItem,
  ): Promise<MercadoLibreListingOutcome> {
    const { accessToken, draft, settings, category } = plan;
    await this.lifecycle.applyStatus(accessToken, item, draft.product.active, totalQuantity(plan));
    const verified = await this.verifier.verify(accessToken, item.id, settings, category.id);
    const variants = hasVariations(plan)
      ? variationKeys(plan, verified.item)
      : draft.variants.map(({ variantId }) => ({
          variantId,
          key: formatVariantKey({ itemId: verified.item.id, variationId: null }),
        }));
    return {
      itemId: verified.item.id,
      url: verified.item.permalink ?? item.permalink ?? null,
      active: verified.active,
      variants,
    };
  }
}
