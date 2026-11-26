import { Injectable } from '@nestjs/common';
import type { ListingDraftVariant } from '../../sdk/capabilities/listing-publisher.js';
import {
  identifierAttributes,
  optionAttributes,
  productAttributes,
} from './mercadolibre-attributes.js';
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
import { parseVariantKey } from './mercadolibre-keys.js';
import type {
  MercadoLibreListingOutcome,
  MercadoLibreListingPlan,
  MercadoLibreListingWriter,
} from './mercadolibre-listing-plan.js';

/** One variant written: its item, and whether that item is active. */
interface WrittenVariant {
  variantId: string;
  item: MercadoLibreItem;
  active: boolean;
}

/** What every write of a variant's item sends: its price, stock and attributes. */
function variantFields(
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

function existingItemId(variant: ListingDraftVariant): string | null {
  const key = variant.externalVariantId ? parseVariantKey(variant.externalVariantId) : null;
  return key?.variationId === null ? key.itemId : null;
}

/**
 * Lists a product under User Products ("Precio por variación"): one item per variant, each
 * with its own price, grouped by a shared `family_name` and the variant's option attributes.
 * Pre-validates each item and reads back to verify without auto-closing on partial failures.
 */
@Injectable()
export class MercadoLibreUserProductWriter implements MercadoLibreListingWriter {
  constructor(
    private readonly items: MercadoLibreItemClient,
    private readonly lifecycle: MercadoLibreItemLifecycle,
    private readonly verifier: MercadoLibreItemVerifier,
  ) {}

  async publish(plan: MercadoLibreListingPlan): Promise<MercadoLibreListingOutcome> {
    const familyName = mercadoLibreTitle(plan.draft, plan.categoryDetails);
    const written: WrittenVariant[] = [];
    for (const variant of plan.draft.variants) {
      written.push(await this.create(plan, variant, familyName));
    }
    return outcomeOf(written);
  }

  async update(plan: MercadoLibreListingPlan, itemId: string): Promise<MercadoLibreListingOutcome> {
    const listingItem = await this.lifecycle.requireOpen(plan.accessToken, itemId);
    const familyName =
      listingItem.family_name ?? mercadoLibreTitle(plan.draft, plan.categoryDetails);
    const written: WrittenVariant[] = [];
    for (const variant of plan.draft.variants) {
      const existing = existingItemId(variant);
      written.push(
        existing
          ? await this.edit(plan, variant, existing)
          : await this.create(plan, variant, familyName),
      );
    }
    return outcomeOf(written);
  }

  private async create(
    plan: MercadoLibreListingPlan,
    variant: ListingDraftVariant,
    familyName: string,
  ): Promise<WrittenVariant> {
    const { accessToken, draft, settings, category, categoryDetails } = plan;
    const payload: MercadoLibreItemInput = {
      ...newItemTerms(draft, settings, category.id, {
        category: categoryDetails,
        listingTypeId: plan.listingTypeId,
        freeShipping: plan.shippingDecision?.freeShipping,
      }),
      family_name: familyName,
      pictures: plan.pictures ?? listingPictures(draft, categoryDetails),
      ...variantFields(plan, variant),
    };
    await this.items.assertValid(accessToken, payload);
    const item = await this.items.create(accessToken, payload);
    await this.items.addDescription(accessToken, item.id, mercadoLibreDescription(draft));
    return this.withStatus(plan, variant, item);
  }

  private async edit(
    plan: MercadoLibreListingPlan,
    variant: ListingDraftVariant,
    itemId: string,
  ): Promise<WrittenVariant> {
    const { accessToken, draft } = plan;
    await this.lifecycle.requireOpen(accessToken, itemId);
    const item = await this.items.update(accessToken, itemId, {
      ...changedPictures(draft, plan.pictures),
      ...variantFields(plan, variant),
    });
    await this.items.replaceDescription(accessToken, itemId, mercadoLibreDescription(draft));
    return this.withStatus(plan, variant, item);
  }

  private async withStatus(
    plan: MercadoLibreListingPlan,
    variant: ListingDraftVariant,
    item: MercadoLibreItem,
  ): Promise<WrittenVariant> {
    await this.lifecycle.applyStatus(
      plan.accessToken,
      item,
      plan.draft.product.active,
      listedQuantity(variant),
    );
    const verified = await this.verifier.verify(
      plan.accessToken,
      item.id,
      plan.settings,
      plan.category.id,
    );
    return { variantId: variant.variantId, item: verified.item, active: verified.active };
  }
}

/** The listing is its first variant's item, and active while any variant's item is. */
function outcomeOf(written: readonly WrittenVariant[]): MercadoLibreListingOutcome {
  const [first] = written;
  return {
    itemId: first?.item.id ?? '',
    url: first?.item.permalink ?? null,
    active: written.some(({ active }) => active),
    variants: written.map(({ variantId, item }) => ({ variantId, key: item.id })),
  };
}
