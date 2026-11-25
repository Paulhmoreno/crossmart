import { Injectable } from '@nestjs/common';
import type { ChannelSession } from '../sdk/auth/channel-session.js';
import type {
  SellerCredentialValues,
  VerifiedSellerAccount,
} from '../sdk/auth/seller-credentials.js';
import type { CatalogSource } from '../sdk/capabilities/catalog-source.js';
import type { ChannelPage, ExternalProduct } from '../sdk/capabilities/catalog.types.js';
import type {
  InventoryQuantityUpdate,
  InventorySync,
  InventoryUpdateFailure,
} from '../sdk/capabilities/inventory-sync.js';
import type {
  ListingDraft,
  ListingPublisher,
  ListingReference,
  PriceUpdate,
  PublishedListing,
} from '../sdk/capabilities/listing-publisher.js';
import type {
  CategoryAspect,
  ChannelCategory,
  TaxonomyProvider,
} from '../sdk/capabilities/taxonomy-provider.js';
import { ChannelAuthStrategy } from '../sdk/channel-auth-strategy.enum.js';
import { ChannelCapability } from '../sdk/channel-capability.enum.js';
import type { SellerCredentialsConnector } from '../sdk/channel-connector.interface.js';
import type { ChannelAccountProfile } from '../sdk/channel-settings.js';
import { ChannelType } from '../sdk/channel-type.enum.js';
import { RateLimitScope, type RateLimitBucket } from '../sdk/rate-limit-bucket.js';
import { WooCommerceAccountVerifier } from './account/woocommerce-account.verifier.js';
import {
  WOOCOMMERCE_CREDENTIAL_FIELDS,
  wooCommerceAccount,
} from './account/woocommerce-credentials.js';
import { WooCommerceCatalogSource } from './catalog/woocommerce-catalog.source.js';
import { WooCommerceInventorySync } from './inventory/woocommerce-inventory-sync.js';
import { WooCommerceListingPublisher } from './publish/woocommerce-listing.publisher.js';
import { WooCommerceTaxonomyProvider } from './taxonomy/woocommerce-taxonomy.provider.js';
import {
  WOOCOMMERCE_CONTENT_LIMITS,
  WOOCOMMERCE_DISPLAY_NAME,
  WOOCOMMERCE_INVENTORY_BATCH_SIZE,
  WOOCOMMERCE_RATE_BUCKET_NAME,
  WOOCOMMERCE_RATE_CAPACITY,
  WOOCOMMERCE_RATE_RESTORE_PER_SECOND,
} from './woocommerce.constants.js';
import { type WooCommerceSettings, parseWooCommerceSettings } from './woocommerce-settings.js';

/**
 * Native WooCommerce REST API v3 channel connector.
 * Uses seller-issued Consumer Key / Consumer Secret over HTTPS Basic Auth (plus optional
 * WordPress Application Password for direct binary photo uploads to `/wp-json/wp/v2/media`).
 *
 * Automatic order ingestion (`FetchOrders`) and live webhooks (`ReceiveWebhooks`) are kept
 * disabled in Phase 2 until Odoo/Crossmart/WooCommerce stock reconciliation is proven.
 */
@Injectable()
export class WooCommerceConnector
  implements
    SellerCredentialsConnector,
    CatalogSource,
    ListingPublisher,
    TaxonomyProvider,
    InventorySync
{
  readonly channel = ChannelType.WooCommerce;
  readonly displayName = WOOCOMMERCE_DISPLAY_NAME;
  readonly authStrategy = ChannelAuthStrategy.SellerCredentials;
  readonly credentialFields = WOOCOMMERCE_CREDENTIAL_FIELDS;
  readonly capabilities: ReadonlySet<ChannelCapability> = new Set([
    ChannelCapability.ImportCatalog,
    ChannelCapability.PublishListings,
    ChannelCapability.UpdatePrice,
    ChannelCapability.UpdateInventory,
    ChannelCapability.ProvideTaxonomy,
  ]);
  readonly requiredScopes: readonly string[] = [];
  readonly contentLimits = WOOCOMMERCE_CONTENT_LIMITS;
  readonly maxBatchSize = WOOCOMMERCE_INVENTORY_BATCH_SIZE;
  readonly rateLimits: readonly RateLimitBucket[] = [
    {
      name: WOOCOMMERCE_RATE_BUCKET_NAME,
      scope: RateLimitScope.Connection,
      capacity: WOOCOMMERCE_RATE_CAPACITY,
      restorePerSecond: WOOCOMMERCE_RATE_RESTORE_PER_SECOND,
    },
  ];

  constructor(
    private readonly accounts: WooCommerceAccountVerifier,
    private readonly catalog: WooCommerceCatalogSource,
    private readonly publisher: WooCommerceListingPublisher,
    private readonly taxonomy: WooCommerceTaxonomyProvider,
    private readonly inventory: WooCommerceInventorySync,
  ) {}

  isConfigured(): boolean {
    return true;
  }

  verifyCredentials(values: SellerCredentialValues): Promise<VerifiedSellerAccount> {
    return this.accounts.verify(values);
  }

  async describeAccount(
    session: ChannelSession,
  ): Promise<ChannelAccountProfile<WooCommerceSettings>> {
    const { account } = await wooCommerceAccount(session);
    return this.accounts.describe(account);
  }

  parseSettings(raw: unknown): WooCommerceSettings {
    return parseWooCommerceSettings(raw);
  }

  fetchProducts(
    session: ChannelSession,
    cursor: string | null,
  ): Promise<ChannelPage<ExternalProduct>> {
    return this.catalog.fetchProducts(session, cursor);
  }

  publish(session: ChannelSession, draft: ListingDraft): Promise<PublishedListing> {
    return this.publisher.publish(session, draft);
  }

  update(
    session: ChannelSession,
    externalId: string,
    draft: ListingDraft,
  ): Promise<PublishedListing> {
    return this.publisher.update(session, externalId, draft);
  }

  delist(session: ChannelSession, externalId: string, reference?: ListingReference): Promise<void> {
    return this.publisher.delist(session, externalId, reference);
  }

  updatePrices(session: ChannelSession, updates: readonly PriceUpdate[]): Promise<void> {
    return this.publisher.updatePrices(session, updates);
  }

  suggestCategories(session: ChannelSession, query: string): Promise<ChannelCategory[]> {
    return this.taxonomy.suggestCategories(session, query);
  }

  categoryAspects(session: ChannelSession, categoryId: string): Promise<CategoryAspect[]> {
    return this.taxonomy.categoryAspects(session, categoryId);
  }

  setQuantities(
    session: ChannelSession,
    updates: readonly InventoryQuantityUpdate[],
  ): Promise<InventoryUpdateFailure[]> {
    return this.inventory.setQuantities(session, updates);
  }

  readQuantities(
    session: ChannelSession,
    externalInventoryIds: readonly string[],
  ): Promise<Map<string, number>> {
    return this.inventory.readQuantities(session, externalInventoryIds);
  }
}
