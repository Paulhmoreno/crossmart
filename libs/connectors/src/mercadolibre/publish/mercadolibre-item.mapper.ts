import { FixedDecimal } from '@crossmart/common';
import type {
  ListingDraft,
  ListingDraftVariant,
} from '../../sdk/capabilities/listing-publisher.js';
import { ChannelErrorCode } from '../../sdk/errors/channel-error-code.enum.js';
import {
  MERCADOLIBRE_DEFAULT_LISTING_TYPE,
  MERCADOLIBRE_PICTURE_MAX_COUNT,
  MERCADOLIBRE_TITLE_MAX_LENGTH,
  MERCADOLIBRE_UNTRACKED_QUANTITY,
  MercadoLibreSaleTermId,
} from '../mercadolibre.constants.js';
import { MercadoLibreBuyingMode } from '../mercadolibre.enums.js';
import { mercadoLibreError } from '../mercadolibre-errors.js';
import { MERCADOLIBRE_SITES } from '../mercadolibre-site.js';
import type { MercadoLibreSettings } from '../mercadolibre-settings.js';
import type { MercadoLibreCategory } from '../taxonomy/mercadolibre-taxonomy.types.js';
import { mercadoLibreCondition } from './mercadolibre-condition.js';
import {
  adaptMercadoLibreDescription,
  adaptMercadoLibreTitle,
} from './mercadolibre-content.adapter.js';
import type {
  MercadoLibreItemInput,
  MercadoLibrePictureInput,
  MercadoLibreSaleTermInput,
  MercadoLibreShippingInput,
} from './mercadolibre-item.types.js';

/** Units a variant lists: its stock (never below 0), or 1 when stock is not tracked. */
export function listedQuantity(variant: ListingDraftVariant): number {
  return variant.tracked ? Math.max(variant.available ?? 0, 0) : MERCADOLIBRE_UNTRACKED_QUANTITY;
}

/** A decimal price as the number Mercado Libre takes, rounded to the currency's decimals. */
export function mercadoLibrePrice(price: string, settings: MercadoLibreSettings): number {
  const decimals = MERCADOLIBRE_SITES[settings.siteId].currencyDecimals;
  return Number((FixedDecimal.parse(price) ?? FixedDecimal.ZERO).toFixed(decimals));
}

/** Ensures a listing price respects the category's real minimum/maximum bounds without auto-raising. */
export function assertCategoryPriceBounds(price: number, category?: MercadoLibreCategory): void {
  const minPrice = category?.settings?.minimum_price;
  if (typeof minPrice === 'number' && price < minPrice) {
    throw mercadoLibreError(
      ChannelErrorCode.RequestRejected,
      `Price ${price} is below Mercado Libre's minimum (${minPrice}) for category ${category?.id}.`,
    );
  }
  const maxPrice = category?.settings?.maximum_price;
  if (typeof maxPrice === 'number' && price > maxPrice) {
    throw mercadoLibreError(
      ChannelErrorCode.RequestRejected,
      `Price ${price} exceeds Mercado Libre's maximum (${maxPrice}) for category ${category?.id}.`,
    );
  }
}

/** The title (or User Products family name): adapted to the category's real max length. */
export function mercadoLibreTitle(draft: ListingDraft, category?: MercadoLibreCategory): string {
  const limit = category?.settings?.max_title_length ?? MERCADOLIBRE_TITLE_MAX_LENGTH;
  return adaptMercadoLibreTitle(draft, limit);
}

/** Descriptions are clean plain text with line breaks; strips links, contact data, and HTML. */
export function mercadoLibreDescription(draft: ListingDraft): string {
  return adaptMercadoLibreDescription(draft);
}

/** Maximum pictures allowed by the category (or default 10). */
export function maxCategoryPictures(category?: MercadoLibreCategory): number {
  return (
    category?.settings?.max_pictures_per_item_var ??
    category?.settings?.max_pictures_per_item ??
    MERCADOLIBRE_PICTURE_MAX_COUNT
  );
}

/** The product's image URLs, bounded by the category's limit. */
export function listingPictures(
  draft: ListingDraft,
  category?: MercadoLibreCategory,
): MercadoLibrePictureInput[] {
  return draft.product.images
    .slice(0, maxCategoryPictures(category))
    .map((image) => ({ source: image.url }));
}

function configuredSaleTerms(settings: MercadoLibreSettings): MercadoLibreSaleTermInput[] {
  const terms: MercadoLibreSaleTermInput[] = [];
  if (settings.warrantyType?.trim()) {
    terms.push({
      id: MercadoLibreSaleTermId.WarrantyType,
      value_name: settings.warrantyType.trim(),
    });
  }
  if (settings.warrantyTime?.trim()) {
    terms.push({
      id: MercadoLibreSaleTermId.WarrantyTime,
      value_name: settings.warrantyTime.trim(),
    });
  }
  return terms;
}

function configuredShipping(
  settings: MercadoLibreSettings,
  category?: MercadoLibreCategory,
): MercadoLibreShippingInput | undefined {
  const shipping: MercadoLibreShippingInput = {};
  const allowedModes = category?.settings?.shipping_modes ?? [];
  if (
    settings.shippingMode &&
    (allowedModes.length === 0 || allowedModes.includes(settings.shippingMode))
  ) {
    shipping.mode = settings.shippingMode;
  }
  if (typeof settings.localPickUp === 'boolean') {
    shipping.local_pick_up = settings.localPickUp;
  }
  return Object.keys(shipping).length > 0 ? shipping : undefined;
}

/** What every new item has: category, currency, configured listing type, terms, and shipping. */
export function newItemTerms(
  draft: ListingDraft,
  settings: MercadoLibreSettings,
  categoryId: string,
  category?: MercadoLibreCategory,
): MercadoLibreItemInput {
  const saleTerms = configuredSaleTerms(settings);
  const shipping = configuredShipping(settings, category);
  return {
    category_id: categoryId,
    currency_id: settings.currencyCode,
    buying_mode: MercadoLibreBuyingMode.BuyItNow,
    listing_type_id: settings.defaultListingTypeId || MERCADOLIBRE_DEFAULT_LISTING_TYPE,
    condition: mercadoLibreCondition(draft.condition),
    ...(saleTerms.length > 0 ? { sale_terms: saleTerms } : {}),
    ...(shipping ? { shipping } : {}),
  };
}

/** The pictures of an update: sent only when they changed, as Mercado Libre downloads them again. */
export function changedPictures(
  draft: ListingDraft,
  resolvedPictures?: readonly MercadoLibrePictureInput[],
): Pick<MercadoLibreItemInput, 'pictures'> {
  if (draft.imagesChanged === false) return {};
  return { pictures: resolvedPictures ? [...resolvedPictures] : listingPictures(draft) };
}
