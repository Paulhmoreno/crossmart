import { Injectable } from '@nestjs/common';
import type { ChannelSession } from '../../sdk/auth/channel-session.js';
import type {
  ListingDraft,
  ListingPublisher,
  ListingReference,
  PublishedListing,
} from '../../sdk/capabilities/listing-publisher.js';
import { ChannelType } from '../../sdk/channel-type.enum.js';
import { ChannelError } from '../../sdk/errors/channel-error.js';
import { MercadoLibreShippingPolicy } from '../mercadolibre.enums.js';
import type { MercadoLibreSettings } from '../mercadolibre-settings.js';
import { MercadoLibreCategoryReader } from '../taxonomy/mercadolibre-category.reader.js';
import { MercadoLibreCategoryAttributesReader } from '../taxonomy/mercadolibre-category-attributes.reader.js';
import {
  MercadoLibreAttributeIndex,
  missingRequiredAttributes,
} from './mercadolibre-attributes.js';
import {
  evaluateMercadoLibreShippingPolicy,
  MercadoLibreCommercialClient,
  type MercadoLibreShippingDecision,
} from './mercadolibre-commercial.client.js';
import { mercadoLibreCondition } from './mercadolibre-condition.js';
import { MercadoLibreItemLifecycle } from './mercadolibre-item-lifecycle.js';
import {
  assertCategoryPriceBounds,
  listingPictures,
  maxCategoryPictures,
  mercadoLibrePrice,
  resolveMercadoLibreListingType,
} from './mercadolibre-item.mapper.js';
import { hasVariationKeys, parseVariantKey } from './mercadolibre-keys.js';
import type {
  MercadoLibreListingOutcome,
  MercadoLibreListingPlan,
  MercadoLibreListingWriter,
} from './mercadolibre-listing-plan.js';
import { MercadoLibreMediaUploader } from './mercadolibre-media.uploader.js';
import {
  MERCADOLIBRE_NO_IMAGES,
  missingAttributesRequirement,
  requireMercadoLibreSettings,
} from './mercadolibre-publish-prerequisites.js';
import { MercadoLibreListingWriters } from './mercadolibre-listing-writers.js';

/**
 * Lists products on Mercado Libre, in the item model the seller's account uses: User Products
 * (an item per variant) when the account has the `user_product_seller` tag, else one item with
 * variations. A listing published as variations stays so. Ending a listing closes its items.
 */
@Injectable()
export class MercadoLibreListingPublisher implements Omit<ListingPublisher, 'updatePrices'> {
  constructor(
    private readonly categories: MercadoLibreCategoryReader,
    private readonly attributes: MercadoLibreCategoryAttributesReader,
    private readonly media: MercadoLibreMediaUploader,
    private readonly writers: MercadoLibreListingWriters,
    private readonly lifecycle: MercadoLibreItemLifecycle,
    private readonly commercial: MercadoLibreCommercialClient,
  ) {}

  async publish(session: ChannelSession, draft: ListingDraft): Promise<PublishedListing> {
    const plan = await this.plan(session, draft, { resolveImages: true, evaluateShipping: true });
    return toPublished(plan, await this.writerFor(plan).publish(plan));
  }

  async update(
    session: ChannelSession,
    externalId: string,
    draft: ListingDraft,
  ): Promise<PublishedListing> {
    const plan = await this.plan(session, draft, {
      resolveImages: draft.imagesChanged !== false,
      evaluateShipping: false,
    });
    return toPublished(plan, await this.writerFor(plan).update(plan, externalId));
  }

  /** Closes the listing's items: its own, and each variant's under User Products. */
  async delist(
    session: ChannelSession,
    externalId: string,
    reference?: ListingReference,
  ): Promise<void> {
    const variantItems = (reference?.variantExternalIds ?? []).flatMap((key) => {
      const itemId = parseVariantKey(key)?.itemId;
      return itemId ? [itemId] : [];
    });
    const itemIds = [...new Set([externalId, ...variantItems])];
    await this.lifecycle.close(await session.accessToken(), itemIds);
  }

  /** Checks settings, pictures, category, price bounds, listing type, shipping, and attributes. */
  private async plan(
    session: ChannelSession,
    draft: ListingDraft,
    options: { resolveImages: boolean; evaluateShipping: boolean },
  ): Promise<MercadoLibreListingPlan> {
    const settings = requireMercadoLibreSettings(draft.accountSettings ?? session.settings);
    if (listingPictures(draft).length === 0) {
      throw ChannelError.unmet(ChannelType.MercadoLibre, MERCADOLIBRE_NO_IMAGES);
    }
    const listingTypeId = resolveMercadoLibreListingType(settings, draft);
    const accessToken = await session.accessToken();
    const { category, details } = await this.categories.resolveForPublish(
      accessToken,
      settings.siteId,
      draft,
    );
    for (const variant of draft.variants) {
      assertCategoryPriceBounds(mercadoLibrePrice(variant.price, settings), details);
    }
    const categoryAttributes = await this.attributes.read(accessToken, category.id);
    const index = new MercadoLibreAttributeIndex(categoryAttributes, settings.userProductSeller);
    const missing = missingRequiredAttributes(draft, index);
    if (missing.length > 0) {
      throw ChannelError.unmet(ChannelType.MercadoLibre, missingAttributesRequirement(missing));
    }
    const shippingDecision = options.evaluateShipping
      ? await this.resolveShippingDecision({
          accessToken,
          draft,
          settings,
          categoryId: category.id,
          listingTypeId,
        })
      : undefined;
    const pictures = options.resolveImages
      ? await this.media.resolvePictures(
          accessToken,
          draft.product.images,
          maxCategoryPictures(details),
        )
      : undefined;
    return {
      accessToken,
      draft,
      settings,
      category,
      categoryDetails: details,
      listingTypeId,
      ...(shippingDecision ? { shippingDecision } : {}),
      ...(pictures ? { pictures } : {}),
      attributes: index,
    };
  }

  private async resolveShippingDecision(params: {
    accessToken: string;
    draft: ListingDraft;
    settings: MercadoLibreSettings;
    categoryId: string;
    listingTypeId: string;
  }): Promise<MercadoLibreShippingDecision | undefined> {
    const { settings, draft } = params;
    if (!settings.shippingPolicy) return undefined;
    const firstVariant = draft.variants[0];
    const referencePrice = firstVariant ? mercadoLibrePrice(firstVariant.price, settings) : 0;
    const quote =
      settings.shippingPolicy === MercadoLibreShippingPolicy.Automatic
        ? await this.commercial.readShippingCost({
            accessToken: params.accessToken,
            userId: settings.userId,
            categoryId: params.categoryId,
            listingTypeId: params.listingTypeId,
            price: referencePrice,
            currencyId: settings.currencyCode,
            condition: mercadoLibreCondition(draft.condition),
          })
        : null;
    return evaluateMercadoLibreShippingPolicy(settings, referencePrice, quote);
  }

  private writerFor(plan: MercadoLibreListingPlan): MercadoLibreListingWriter {
    const published = plan.draft.variants.map((variant) => variant.externalVariantId);
    if (hasVariationKeys(published)) return this.writers.singleItem;
    return plan.settings.userProductSeller ? this.writers.userProduct : this.writers.singleItem;
  }
}

function toPublished(
  plan: MercadoLibreListingPlan,
  outcome: MercadoLibreListingOutcome,
): PublishedListing {
  return {
    externalId: outcome.itemId,
    externalUrl: outcome.url,
    active: outcome.active,
    variants: outcome.variants.map(({ variantId, key }) => ({
      variantId,
      externalId: key,
      externalInventoryId: key,
    })),
    category: plan.category,
  };
}
