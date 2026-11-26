import { z } from 'zod';
import type { ChannelSettings } from '../sdk/channel-settings.js';
import { ChannelType } from '../sdk/channel-type.enum.js';
import { MERCADOLIBRE_NUMERIC_ID_PATTERN } from './mercadolibre.constants.js';
import { MercadoLibreShippingMode } from './mercadolibre.enums.js';
import { MercadoLibreSiteId } from './mercadolibre-site.js';

const CURRENCY_CODE_LENGTH = 3;
const MAX_WARRANTY_LENGTH = 80;
const MAX_LISTING_TYPE_ID_LENGTH = 64;

export const mercadoLibreListingTypeOptionSchema = z.object({
  id: z.string().min(1).max(MAX_LISTING_TYPE_ID_LENGTH),
  name: z.string().min(1),
});

export type MercadoLibreListingTypeOption = z.infer<typeof mercadoLibreListingTypeOptionSchema>;

/** What Crossmart keeps about a connected Mercado Libre seller and their store commercial setup. */
export const mercadoLibreSettingsSchema = z
  .object({
    channel: z.literal(ChannelType.MercadoLibre),
    userId: z.string().regex(MERCADOLIBRE_NUMERIC_ID_PATTERN),
    nickname: z.string().min(1),
    /** The site the seller sells on; their listings are published there. */
    siteId: z.enum(MercadoLibreSiteId),
    /** The site's currency: what listings are priced in. */
    currencyCode: z.string().length(CURRENCY_CODE_LENGTH),
    /** The seller's public profile. */
    permalink: z.string().nullable(),
    /**
     * Whether the seller lists under User Products (`user_product_seller`): one item per
     * variant grouped by `family_name`, instead of one item with variations.
     */
    userProductSeller: z.boolean(),
    /** Site listing types read from `GET /sites/{site_id}/listing_types`. */
    availableListingTypes: z.array(mercadoLibreListingTypeOptionSchema).optional(),
    /** Explicit listing type chosen by the merchant (e.g. `gold_special`, `gold_pro`, `free`). */
    defaultListingTypeId: z.string().min(1).max(MAX_LISTING_TYPE_ID_LENGTH).nullable().optional(),
    /** Explicit shipping mode when the merchant configures it; null lets Mercado Libre decide. */
    shippingMode: z.enum(MercadoLibreShippingMode).nullable().optional(),
    /** Whether local pickup is allowed on new listings when supported by the site/category. */
    localPickUp: z.boolean().nullable().optional(),
    /** Commercial warranty type (e.g. `Garantía del vendedor`), omitted when null. */
    warrantyType: z.string().max(MAX_WARRANTY_LENGTH).nullable().optional(),
    /** Commercial warranty duration (e.g. `6 meses`), omitted when null. */
    warrantyTime: z.string().max(MAX_WARRANTY_LENGTH).nullable().optional(),
    /**
     * Safety switch for order import / stock reservation. Defaults to false until reconciled
     * with Odoo as inventory master.
     */
    importOrders: z.boolean().optional(),
  })
  .strict();

export type MercadoLibreSettings = z.infer<typeof mercadoLibreSettingsSchema> & ChannelSettings;

export interface MercadoLibreListingSetupInput {
  defaultListingTypeId?: string | null;
  shippingMode?: MercadoLibreShippingMode | null;
  localPickUp?: boolean | null;
  warrantyType?: string | null;
  warrantyTime?: string | null;
  importOrders?: boolean;
}

export function parseMercadoLibreSettings(raw: unknown): MercadoLibreSettings {
  return mercadoLibreSettingsSchema.parse(raw);
}

export function isMercadoLibreSettings(
  settings: ChannelSettings,
): settings is MercadoLibreSettings {
  return settings.channel === ChannelType.MercadoLibre;
}
