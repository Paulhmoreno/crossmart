/**
 * Mercado Libre's local-site API (`https://api.mercadolibre.com`), from its developer guides
 * (developers.mercadolibre.com.mx/en_us), except where a comment says otherwise.
 */
export const MERCADOLIBRE_DISPLAY_NAME = 'Mercado Libre';

export const MERCADOLIBRE_API_BASE_URL = 'https://api.mercadolibre.com';
/** Appended to the site's auth origin (Authentication and Authorization guide). */
export const MERCADOLIBRE_AUTHORIZE_PATH = '/authorization';
export const MERCADOLIBRE_TOKEN_PATH = '/oauth/token';
/** "after the refresh_token expires (6 months), it will automatically expire". */
export const MERCADOLIBRE_REFRESH_TOKEN_LIFETIME_SECONDS = 180 * 24 * 60 * 60;

/**
 * Scopes come from the app's settings in DevCenter, not the authorize URL; the token response
 * lists them. `offline_access` is what yields a refresh token.
 */
export const MERCADOLIBRE_REQUIRED_SCOPES: readonly string[] = ['offline_access', 'read', 'write'];

/** Path parameters, replaced in the paths below. */
export enum MercadoLibrePathParam {
  UserId = '{user_id}',
  AppId = '{app_id}',
  SiteId = '{site_id}',
  CategoryId = '{category_id}',
  ItemId = '{item_id}',
  OrderId = '{order_id}',
}

export const MERCADOLIBRE_ME_PATH = '/users/me';
export const MERCADOLIBRE_GRANT_PATH = '/users/{user_id}/applications/{app_id}';
export const MERCADOLIBRE_SITE_LISTING_TYPES_PATH = '/sites/{site_id}/listing_types';
export const MERCADOLIBRE_SITE_LISTING_PRICES_PATH = '/sites/{site_id}/listing_prices';
export const MERCADOLIBRE_USER_FREE_SHIPPING_PATH = '/users/{user_id}/shipping_options/free';
export const MERCADOLIBRE_DOMAIN_DISCOVERY_PATH = '/sites/{site_id}/domain_discovery/search';
export const MERCADOLIBRE_CATEGORY_PATH = '/categories/{category_id}';
export const MERCADOLIBRE_CATEGORY_ATTRIBUTES_PATH = '/categories/{category_id}/attributes';
export const MERCADOLIBRE_ITEMS_PATH = '/items';
export const MERCADOLIBRE_ITEMS_VALIDATE_PATH = '/items/validate';
export const MERCADOLIBRE_ITEM_PATH = '/items/{item_id}';
export const MERCADOLIBRE_ITEM_DESCRIPTION_PATH = '/items/{item_id}/description';
export const MERCADOLIBRE_PICTURES_UPLOAD_PATH = '/pictures/items/upload';
export const MERCADOLIBRE_USER_ITEMS_SEARCH_PATH = '/users/{user_id}/items/search';
export const MERCADOLIBRE_CATALOG_SEARCH_PATH = '/products/search';
export const MERCADOLIBRE_ORDERS_SEARCH_PATH = '/orders/search';
export const MERCADOLIBRE_ORDER_PATH = '/orders/{order_id}';

/** Query parameters. */
export enum MercadoLibreQueryParam {
  Query = 'q',
  Limit = 'limit',
  Offset = 'offset',
  Seller = 'seller',
  SellerSku = 'seller_sku',
  SiteId = 'site_id',
  Status = 'status',
  ProductIdentifier = 'product_identifier',
  Sort = 'sort',
  LastUpdatedFrom = 'order.date_last_updated.from',
  ApiVersion = 'api_version',
  Price = 'price',
  ItemPrice = 'item_price',
  CategoryId = 'category_id',
  CurrencyId = 'currency_id',
  ListingTypeId = 'listing_type_id',
  Condition = 'condition',
  Dimensions = 'dimensions',
}

/** `api_version=2` makes description errors name the character at fault. */
export const MERCADOLIBRE_DESCRIPTION_API_VERSION = '2';
export const MERCADOLIBRE_SORT_DATE_ASCENDING = 'date_asc';
/** Order date filters are written with an offset, `…T00:00:00.000-00:00` (Manage sales guide). */
export const UTC_DESIGNATOR = 'Z';
export const MERCADOLIBRE_UTC_OFFSET = '-00:00';
/** The default (and documented) page size of `/orders/search`. */
export const MERCADOLIBRE_ORDERS_PAGE_SIZE = 50;
/** `domain_discovery` answers 4 predictions by default and 8 at most. */
export const MERCADOLIBRE_CATEGORY_SUGGESTIONS_MAX = 4;
export const MERCADOLIBRE_CATEGORY_PATH_SEPARATOR = ' > ';
/** Values shown per attribute; the rest can still be typed in. */
export const MERCADOLIBRE_ATTRIBUTE_VALUES_MAX = 50;
/** Category attributes change rarely; each process keeps them this long. */
export const MERCADOLIBRE_ATTRIBUTES_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Listing content limits. Titles are limited per category (`max_title_length`, 60 in every
 * example), descriptions by `max_description_length` (50,000). Crossmart uses the documented
 * values for every category.
 */
export const MERCADOLIBRE_TITLE_MAX_LENGTH = 60;
export const MERCADOLIBRE_DESCRIPTION_MAX_LENGTH = 50_000;
export const MERCADOLIBRE_DESCRIPTION_TARGET_LENGTH = 5_000;
/** `max_pictures_per_item_var` is 10, the smallest picture limit the guides show. */
export const MERCADOLIBRE_PICTURE_MAX_COUNT = 10;

/** Item attributes Crossmart fills itself (the Attributes and Product identifiers guides). */
export enum MercadoLibreAttributeId {
  Brand = 'BRAND',
  Model = 'MODEL',
  Gtin = 'GTIN',
  EmptyGtinReason = 'EMPTY_GTIN_REASON',
  SellerSku = 'SELLER_SKU',
  ItemCondition = 'ITEM_CONDITION',
  PackageWeight = 'SELLER_PACKAGE_WEIGHT',
  PackageLength = 'SELLER_PACKAGE_LENGTH',
  PackageWidth = 'SELLER_PACKAGE_WIDTH',
  PackageHeight = 'SELLER_PACKAGE_HEIGHT',
}

/** Sale term ids for commercial warranty terms (`sale_terms`). */
export enum MercadoLibreSaleTermId {
  WarrantyType = 'WARRANTY_TYPE',
  WarrantyTime = 'WARRANTY_TIME',
}

/** `/users` tag of sellers who list under User Products ("Precio por variación"). */
export const MERCADOLIBRE_USER_PRODUCT_SELLER_TAG = 'user_product_seller';

/** Untracked variants list this many units, as on eBay and Etsy. */
export const MERCADOLIBRE_UNTRACKED_QUANTITY = 1;

/** `{itemId}:{variationId}`: the stock of one variation of a single item. */
export const MERCADOLIBRE_VARIATION_ID_SEPARATOR = ':';

/** Mercado Libre's own error messages are cut to this length before they reach merchants. */
export const MERCADOLIBRE_MESSAGE_MAX_LENGTH = 300;
export const MERCADOLIBRE_CAUSE_SEPARATOR = '; ';

/**
 * Mercado Libre publishes no rate in calls per second: limits apply per app and endpoint, and
 * the documented app object shows `max_requests_per_hour: 18000` (5 a second).
 */
export const MERCADOLIBRE_API_BUCKET_NAME = 'mercadolibre-api';
export const MERCADOLIBRE_API_BUCKET_CAPACITY = 10;
export const MERCADOLIBRE_API_RESTORE_PER_SECOND = 5;
/** Largest stock batch one `setQuantities` call takes; an item with variations costs two calls. */
export const MERCADOLIBRE_STOCK_BATCH_SIZE = 50;

/** User, app and order ids are positive integers. */
export const MERCADOLIBRE_NUMERIC_ID_PATTERN = /^[1-9]\d*$/;

/** `resource` of an `orders_v2` notification: `/orders/{order id}`. */
export const MERCADOLIBRE_ORDER_RESOURCE_PATTERN = /^\/orders\/(\d+)$/;
/** `resource` of an `items` or `items_prices` notification: `/items/{item id}` (e.g. `MEC123456`). */
export const MERCADOLIBRE_ITEM_RESOURCE_PATTERN = /^\/items\/([A-Z]{2,4}\d+)$/i;
/** `resource` of a moderation notification carrying an item id. */
export const MERCADOLIBRE_MODERATION_RESOURCE_PATTERN = /([A-Z]{2,4}\d+)/i;
/** Sub-statuses that mean Mercado Libre moderated, paused, or blocked the listing. */
export const MERCADOLIBRE_BLOCKING_SUB_STATUSES: ReadonlySet<string> = new Set([
  'suspended',
  'forbidden',
  'held',
  'waiting_for_patch',
  'deleted',
  'banned',
  'picture_download_pending',
]);
/** The name a merchant and buyer see for an order. */
export const MERCADOLIBRE_ORDER_NAME_PREFIX = '#';
