import { Module } from '@nestjs/common';
import { ConnectorRuntimeModule } from '../sdk/connector-runtime.module.js';
import { WooCommerceAccountVerifier } from './account/woocommerce-account.verifier.js';
import { WooCommerceApiClient } from './api/woocommerce-api.client.js';
import { WooCommerceCatalogSource } from './catalog/woocommerce-catalog.source.js';
import { WooCommerceInventorySync } from './inventory/woocommerce-inventory-sync.js';
import { WooCommerceOrderSource } from './orders/woocommerce-order-source.js';
import { WooCommerceListingPublisher } from './publish/woocommerce-listing.publisher.js';
import { WooCommerceMediaUploader } from './publish/woocommerce-media.uploader.js';
import { WooCommerceTaxonomyProvider } from './taxonomy/woocommerce-taxonomy.provider.js';
import { WooCommerceConnector } from './woocommerce.connector.js';

@Module({
  imports: [ConnectorRuntimeModule],
  providers: [
    WooCommerceApiClient,
    WooCommerceAccountVerifier,
    WooCommerceCatalogSource,
    WooCommerceTaxonomyProvider,
    WooCommerceMediaUploader,
    WooCommerceListingPublisher,
    WooCommerceInventorySync,
    WooCommerceOrderSource,
    WooCommerceConnector,
  ],
  exports: [WooCommerceConnector, WooCommerceOrderSource],
})
export class WooCommerceConnectorModule {}
