import { z } from 'zod';
import type { ChannelSettings } from '../sdk/channel-settings.js';
import { ChannelType } from '../sdk/channel-type.enum.js';
import {
  WOOCOMMERCE_DEFAULT_CURRENCY,
  WOOCOMMERCE_DEFAULT_DIMENSION_UNIT,
  WOOCOMMERCE_DEFAULT_WEIGHT_UNIT,
} from './woocommerce.constants.js';
import { WooCommercePublishStatus } from './woocommerce.enums.js';

export const wooCommerceSettingsSchema = z.object({
  channel: z.literal(ChannelType.WooCommerce),
  storeUrl: z.string().url(),
  storeName: z.string().min(1),
  currencyCode: z.string().min(1).default(WOOCOMMERCE_DEFAULT_CURRENCY),
  pricesIncludeTax: z.boolean().default(false),
  weightUnit: z.string().min(1).default(WOOCOMMERCE_DEFAULT_WEIGHT_UNIT),
  dimensionUnit: z.string().min(1).default(WOOCOMMERCE_DEFAULT_DIMENSION_UNIT),
  defaultStatus: z.nativeEnum(WooCommercePublishStatus).default(WooCommercePublishStatus.Draft),
  hasWordPressMediaAuth: z.boolean().default(false),
  wpUsername: z.string().nullable().default(null),
  remoteProductCount: z.number().int().min(0).nullable().default(null),
});

export type WooCommerceSettings = z.infer<typeof wooCommerceSettingsSchema>;

export function parseWooCommerceSettings(raw: unknown): WooCommerceSettings {
  return wooCommerceSettingsSchema.parse(raw);
}

export function isWooCommerceSettings(settings: ChannelSettings): settings is WooCommerceSettings {
  return settings.channel === ChannelType.WooCommerce;
}
