import { DescriptionFormat } from '../sdk/content/description-format.enum.js';
import type { ChannelContentLimits } from '../sdk/content/channel-content-limits.js';

export const WOOCOMMERCE_DISPLAY_NAME = 'WooCommerce';
export const WOOCOMMERCE_CREDENTIALS_GUIDE_URL =
  'https://developer.woocommerce.com/docs/apis/rest-api/authentication/';

export const WOOCOMMERCE_REST_BASE = '/wp-json/wc/v3';
export const WORDPRESS_REST_BASE = '/wp-json/wp/v2';
export const WORDPRESS_API_INDEX = '/wp-json/';

export const WOOCOMMERCE_RATE_BUCKET_NAME = 'woocommerce-rest';
export const WOOCOMMERCE_RATE_CAPACITY = 20;
export const WOOCOMMERCE_RATE_RESTORE_PER_SECOND = 5;

export const WOOCOMMERCE_INVENTORY_BATCH_SIZE = 50;
export const WOOCOMMERCE_CATALOG_PAGE_SIZE = 50;
export const WOOCOMMERCE_TAXONOMY_PAGE_SIZE = 100;
export const WOOCOMMERCE_MAX_TAXONOMY_PAGES = 10;
export const WOOCOMMERCE_MAX_IMAGES = 20;
export const WOOCOMMERCE_MAX_TAGS = 30;
export const WOOCOMMERCE_MAX_TITLE_LENGTH = 255;
export const WOOCOMMERCE_MAX_DESCRIPTION_LENGTH = 65_535;
export const WOOCOMMERCE_SHORT_DESCRIPTION_MAX_LENGTH = 400;

export const WOOCOMMERCE_URL_MAX_LENGTH = 512;
export const WOOCOMMERCE_KEY_MAX_LENGTH = 256;
export const WOOCOMMERCE_USERNAME_MAX_LENGTH = 256;
export const WOOCOMMERCE_STATUS_MAX_LENGTH = 32;

export const WOOCOMMERCE_META_PRODUCT_ID = '_crossmart_product_id';
export const WOOCOMMERCE_META_MEDIA_MAP = '_crossmart_media_map';
export const WOOCOMMERCE_INVENTORY_ID_SEPARATOR = ':';
export const WOOCOMMERCE_DEFAULT_CURRENCY = 'USD';
export const WOOCOMMERCE_DEFAULT_WEIGHT_UNIT = 'kg';
export const WOOCOMMERCE_DEFAULT_DIMENSION_UNIT = 'cm';

export const WOOCOMMERCE_SHORT_DESCRIPTION_KEYS = new Set([
  'short description',
  'short_description',
  'descripcion corta',
  'descripción corta',
]);

export const WOOCOMMERCE_DESCRIPTION_TARGET_LENGTH = 1500;

export const WOOCOMMERCE_CONTENT_LIMITS: ChannelContentLimits = {
  titleMaxLength: WOOCOMMERCE_MAX_TITLE_LENGTH,
  descriptionMaxLength: WOOCOMMERCE_MAX_DESCRIPTION_LENGTH,
  descriptionTargetLength: WOOCOMMERCE_DESCRIPTION_TARGET_LENGTH,
  descriptionFormat: DescriptionFormat.RichHtml,
  allowsLinks: true,
};
