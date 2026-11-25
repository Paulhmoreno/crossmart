/** Keys accepted by `POST /channel-connections/credentials` for WooCommerce. */
export enum WooCommerceCredentialField {
  StoreUrl = 'storeUrl',
  ConsumerKey = 'consumerKey',
  ConsumerSecret = 'consumerSecret',
  WpUsername = 'wpUsername',
  WpAppPassword = 'wpAppPassword',
  DefaultStatus = 'defaultStatus',
}

/** Initial status used when Crossmart creates a new product in WooCommerce. */
export enum WooCommercePublishStatus {
  Draft = 'draft',
  Publish = 'publish',
}
