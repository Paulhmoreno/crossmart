import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { FileStorage } from '@crossmart/common';
import type { ChannelSession } from '../sdk/auth/channel-session.js';
import { ChannelCapability } from '../sdk/channel-capability.enum.js';
import { ChannelType } from '../sdk/channel-type.enum.js';
import { ChannelError } from '../sdk/errors/channel-error.js';
import { ChannelErrorCode } from '../sdk/errors/channel-error-code.enum.js';
import { ChannelWebhookKind } from '../sdk/capabilities/webhook-receiver.js';
import { HttpMethod } from '../sdk/http/http-method.enum.js';
import { FakeImageFetcher } from '../sdk/images/fake-image-fetcher.js';
import { PublishRequirement } from '../sdk/publishing/publish-requirement.enum.js';
import { fakeChannelSession } from '../sdk/testing/fake-channel-session.js';
import { FakeHttpTransport, jsonResponse } from '../sdk/testing/fake-http-transport.js';
import { WooCommerceAccountVerifier } from './account/woocommerce-account.verifier.js';
import { serializeWooCommerceSecrets } from './account/woocommerce-credentials.js';
import { WooCommerceApiClient } from './api/woocommerce-api.client.js';
import { WooCommerceCatalogSource } from './catalog/woocommerce-catalog.source.js';
import { WooCommerceInventorySync } from './inventory/woocommerce-inventory-sync.js';
import { WooCommerceOrderSource } from './orders/woocommerce-order-source.js';
import { WooCommerceListingPublisher } from './publish/woocommerce-listing.publisher.js';
import { WooCommerceMediaUploader } from './publish/woocommerce-media.uploader.js';
import { WooCommerceTaxonomyProvider } from './taxonomy/woocommerce-taxonomy.provider.js';
import { verifyWooCommerceWebhook } from './webhooks/woocommerce-webhook-parser.js';
import {
  WOOCOMMERCE_META_MEDIA_MAP,
  WOOCOMMERCE_META_PRODUCT_ID,
} from './woocommerce.constants.js';
import { WooCommercePublishStatus } from './woocommerce.enums.js';
import type { WooCommerceSettings } from './woocommerce-settings.js';
import { WooCommerceConnector } from './woocommerce.connector.js';

const STORE_URL = 'https://store.example.com';

function createHarness(storage?: Partial<FileStorage>) {
  const http = new FakeHttpTransport();
  const api = new WooCommerceApiClient(http);
  const accounts = new WooCommerceAccountVerifier(api);
  const catalog = new WooCommerceCatalogSource(api);
  const taxonomy = new WooCommerceTaxonomyProvider(api);
  const fetcher = new FakeImageFetcher();
  const media = new WooCommerceMediaUploader(api, fetcher, storage as FileStorage | undefined);
  const publisher = new WooCommerceListingPublisher(api, media, taxonomy);
  const inventory = new WooCommerceInventorySync(api);
  const orders = new WooCommerceOrderSource(api);
  const connector = new WooCommerceConnector(accounts, catalog, publisher, taxonomy, inventory);
  return { http, connector, orders, fetcher };
}

function makeSession(withWpMedia = true): ChannelSession {
  const token = serializeWooCommerceSecrets({
    consumerKey: 'ck_test_123',
    consumerSecret: 'cs_test_456',
    ...(withWpMedia ? { wpUsername: 'media_user', wpAppPassword: 'wp_app_password' } : {}),
  });
  const settings: WooCommerceSettings = {
    channel: ChannelType.WooCommerce,
    storeUrl: STORE_URL,
    storeName: 'Sample Store',
    currencyCode: 'USD',
    pricesIncludeTax: true,
    weightUnit: 'kg',
    dimensionUnit: 'cm',
    defaultStatus: WooCommercePublishStatus.Draft,
    hasWordPressMediaAuth: withWpMedia,
    wpUsername: withWpMedia ? 'media_user' : null,
    remoteProductCount: 12,
  };
  return {
    ...fakeChannelSession('store.example.com', token),
    settings,
  };
}

describe('WooCommerceConnector', () => {
  it('declares Phase 2 capabilities and keeps automatic order/webhook ingestion disabled', () => {
    const { connector } = createHarness();
    expect(connector.channel).toBe(ChannelType.WooCommerce);
    expect(connector.capabilities.has(ChannelCapability.PublishListings)).toBe(true);
    expect(connector.capabilities.has(ChannelCapability.ImportCatalog)).toBe(true);
    expect(connector.capabilities.has(ChannelCapability.ProvideTaxonomy)).toBe(true);
    expect(connector.capabilities.has(ChannelCapability.UpdateInventory)).toBe(true);
    expect(connector.capabilities.has(ChannelCapability.UpdatePrice)).toBe(true);
    expect(connector.capabilities.has(ChannelCapability.FetchOrders)).toBe(false);
    expect(connector.capabilities.has(ChannelCapability.ReceiveWebhooks)).toBe(false);
  });

  it('verifies WooCommerce and WordPress media credentials via Basic Auth (never in query strings)', async () => {
    const { http, connector } = createHarness();
    http
      .expect(
        HttpMethod.Get,
        /\/wp-json\/wc\/v3\/products\?per_page=1/,
        jsonResponse([{ id: 10, name: 'Existing' }], 200, { 'x-wp-total': '42' }),
      )
      .expect(
        HttpMethod.Get,
        /\/wp-json\/wc\/v3\/settings\/general/,
        jsonResponse([
          { id: 'woocommerce_currency', value: 'USD' },
          { id: 'woocommerce_prices_include_tax', value: 'yes' },
        ]),
      )
      .expect(HttpMethod.Get, /\/wp-json\/$/, jsonResponse({ name: 'Tienda Demo' }))
      .expect(
        HttpMethod.Get,
        /\/wp-json\/wc\/v3\/settings\/products/,
        jsonResponse([
          { id: 'woocommerce_weight_unit', value: 'kg' },
          { id: 'woocommerce_dimension_unit', value: 'cm' },
        ]),
      )
      .expect(
        HttpMethod.Get,
        /\/wp-json\/wp\/v2\/users\/me/,
        jsonResponse({ id: 7, name: 'Media', capabilities: { upload_files: true } }),
      );

    const verified = await connector.verifyCredentials({
      storeUrl: 'https://Store.Example.com/',
      consumerKey: 'ck_test_123',
      consumerSecret: 'cs_test_456',
      wpUsername: 'media_user',
      wpAppPassword: 'wp_app_password',
      defaultStatus: 'draft',
    });

    expect(verified.externalAccountId).toBe('store.example.com');
    expect(verified.profile.displayName).toBe('Tienda Demo');
    expect(verified.profile.settings).toMatchObject({
      channel: ChannelType.WooCommerce,
      currencyCode: 'USD',
      pricesIncludeTax: true,
      hasWordPressMediaAuth: true,
      remoteProductCount: 42,
    });
    for (const req of http.requests) {
      expect(req.url).not.toContain('ck_test_123');
      expect(req.url).not.toContain('cs_test_456');
      expect(req.url).not.toContain('wp_app_password');
    }
    http.assertDone();
  });

  it('rejects non-HTTPS store URLs and invalid credentials cleanly', async () => {
    const { http, connector } = createHarness();
    await expect(
      connector.verifyCredentials({
        storeUrl: 'http://insecure.example.com',
        consumerKey: 'ck_1',
        consumerSecret: 'cs_1',
      }),
    ).rejects.toThrow(ChannelError);

    http
      .expect(
        HttpMethod.Get,
        /\/wp-json\/wc\/v3\/products\?per_page=1/,
        jsonResponse({ code: 'woocommerce_rest_cannot_view', message: 'Denied' }, 401),
      )
      .expect(
        HttpMethod.Get,
        /\/wp-json\/wc\/v3\/settings\/general/,
        jsonResponse({ code: 'woocommerce_rest_cannot_view', message: 'Denied' }, 401),
      )
      .expect(HttpMethod.Get, /\/wp-json\/$/, jsonResponse({ name: 'Store' }));

    await expect(
      connector.verifyCredentials({
        storeUrl: STORE_URL,
        consumerKey: 'ck_bad',
        consumerSecret: 'cs_bad',
      }),
    ).rejects.toMatchObject({ code: ChannelErrorCode.CredentialsRejected });
  });

  it('uploads local Crossmart images via WordPress Media API and blocks localhost images without WP auth', async () => {
    const localStorage: Partial<FileStorage> = {
      readByUrl: vi.fn().mockResolvedValue({
        bytes: Buffer.from('fake-webp-bytes'),
        contentType: 'image/webp',
        fileName: 'photo-1.webp',
      }),
    };
    const { http, connector } = createHarness(localStorage);

    // 1. Without WordPress Media auth, a localhost image MUST fail with PublishRequirement.Images
    http
      .expect(HttpMethod.Get, /\/wp-json\/wc\/v3\/products\?sku=/, jsonResponse([]))
      .expect(
        HttpMethod.Get,
        /\/wp-json\/wc\/v3\/products\/brands\?slug=brand/,
        jsonResponse([{ id: 33, name: 'Brand', slug: 'brand' }]),
      );
    await expect(
      connector.publish(makeSession(false), {
        productId: 'prod-1',
        product: {
          handle: 'sample-item',
          title: 'Sample Item',
          descriptionHtml: '<p>Details</p>',
          vendor: 'Brand',
          productType: null,
          tags: [],
          active: true,
          optionNames: [],
          images: [{ url: 'http://localhost:3300/media/ws/photo-1.webp', altText: 'Front' }],
        },
        variants: [
          {
            variantId: 'var-1',
            sku: 'SKU-001',
            barcode: '0000000000001',
            optionValues: [],
            price: '15.00',
            compareAtPrice: null,
            tracked: true,
            available: 4,
            weightGrams: 500,
            requiresShipping: true,
            taxable: true,
            continueSellingWhenOutOfStock: false,
            unitCost: null,
          },
        ],
      }),
    ).rejects.toMatchObject({ requirement: PublishRequirement.Images });

    // 2. With WordPress Media auth, binary image uploads to /wp-json/wp/v2/media and links by { id }
    http
      .expect(HttpMethod.Get, /\/wp-json\/wc\/v3\/products\?sku=/, jsonResponse([]))
      .expect(
        HttpMethod.Get,
        /\/wp-json\/wc\/v3\/products\/brands\?slug=brand/,
        jsonResponse([{ id: 33, name: 'Brand', slug: 'brand' }]),
      )
      .expect(
        HttpMethod.Post,
        /\/wp-json\/wp\/v2\/media$/,
        jsonResponse(
          { id: 777, source_url: 'https://store.example.com/wp-content/uploads/photo-1.webp' },
          201,
        ),
      )
      .expect(HttpMethod.Post, /\/wp-json\/wp\/v2\/media\/777$/, jsonResponse({ id: 777 }))
      .expect(
        HttpMethod.Post,
        /\/wp-json\/wc\/v3\/products$/,
        jsonResponse(
          {
            id: 501,
            permalink: 'https://store.example.com/product/sample-item/',
            status: 'draft',
            images: [{ id: 777, src: 'https://store.example.com/wp-content/uploads/photo-1.webp' }],
          },
          201,
        ),
      )
      .expect(
        HttpMethod.Get,
        /\/wp-json\/wc\/v3\/products\/501/,
        jsonResponse({
          id: 501,
          name: 'Sample Item',
          permalink: 'https://store.example.com/product/sample-item/',
          status: 'draft',
          description: '<p>Details</p>',
          short_description: '<p>Details</p>',
          sku: 'SKU-001',
          global_unique_id: '0000000000001',
          regular_price: '19.00',
          sale_price: '15.00',
          manage_stock: true,
          stock_quantity: 4,
          stock_status: 'instock',
          brands: [{ id: 33, name: 'Brand', slug: 'brand' }],
          images: [{ id: 777, src: 'https://store.example.com/wp-content/uploads/photo-1.webp' }],
          meta_data: [
            { key: WOOCOMMERCE_META_PRODUCT_ID, value: 'prod-1' },
            {
              key: WOOCOMMERCE_META_MEDIA_MAP,
              value: JSON.stringify({ 'http://localhost:3300/media/ws/photo-1.webp': 777 }),
            },
          ],
        }),
      );

    const published = await connector.publish(makeSession(true), {
      productId: 'prod-1',
      product: {
        handle: 'sample-item',
        title: 'Sample Item',
        descriptionHtml: '<p>Details</p>',
        vendor: 'Brand',
        productType: null,
        tags: [],
        active: true,
        optionNames: [],
        images: [{ url: 'http://localhost:3300/media/ws/photo-1.webp', altText: 'Front' }],
      },
      variants: [
        {
          variantId: 'var-1',
          sku: 'SKU-001',
          barcode: '0000000000001',
          optionValues: [],
          price: '15.00',
          compareAtPrice: '19.00',
          tracked: true,
          available: 4,
          weightGrams: 500,
          requiresShipping: true,
          taxable: true,
          continueSellingWhenOutOfStock: false,
          unitCost: null,
        },
      ],
    });

    expect(published).toMatchObject({
      externalId: '501',
      active: false,
      variants: [{ variantId: 'var-1', externalId: '501', externalInventoryId: '501' }],
    });
    const createReq = http.requests.find((req) => req.url.endsWith('/wp-json/wc/v3/products'));
    const body = JSON.parse(createReq?.body ?? '{}');
    expect(body.images).toEqual([{ id: 777, alt: 'Front' }]);
    expect(body.regular_price).toBe('19.00');
    expect(body.sale_price).toBe('15.00');
    expect(body.global_unique_id).toBe('0000000000001');
    expect(body.weight).toBe('0.5');
    expect(body.status).toBe('draft');
    http.assertDone();
  });

  it('refuses to duplicate or overwrite an unlinked existing SKU in WooCommerce', async () => {
    const { http, connector } = createHarness();
    http.expect(
      HttpMethod.Get,
      /\/wp-json\/wc\/v3\/products\?sku=/,
      jsonResponse([{ id: 88, sku: 'EXISTING-SKU', status: 'publish', meta_data: [] }]),
    );

    await expect(
      connector.publish(makeSession(true), {
        productId: 'prod-new',
        product: {
          handle: 'new-item',
          title: 'New Item',
          descriptionHtml: '',
          vendor: null,
          productType: null,
          tags: [],
          active: true,
          optionNames: [],
          images: [],
        },
        variants: [
          {
            variantId: 'var-1',
            sku: 'EXISTING-SKU',
            barcode: null,
            optionValues: [],
            price: '10.00',
            compareAtPrice: null,
            tracked: true,
            available: 2,
            weightGrams: null,
            requiresShipping: true,
            taxable: true,
            continueSellingWhenOutOfStock: false,
            unitCost: null,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: ChannelErrorCode.RequestRejected });
  });

  it('reads existing catalog products, verifies signed webhooks, and maps read-only orders', async () => {
    const { http, connector, orders } = createHarness();
    http.expect(
      HttpMethod.Get,
      /\/wp-json\/wc\/v3\/products\?per_page=50/,
      jsonResponse(
        [
          {
            id: 300,
            name: 'Remote Mug',
            slug: 'remote-mug',
            permalink: 'https://store.example.com/product/remote-mug/',
            type: 'simple',
            status: 'publish',
            description: '<p>Ceramic</p>',
            short_description: 'Ceramic',
            sku: 'MUG-01',
            global_unique_id: '0000000000099',
            price: '12.50',
            regular_price: '12.50',
            sale_price: '',
            manage_stock: true,
            stock_quantity: 9,
            stock_status: 'instock',
            backorders: 'no',
            weight: '0.35',
            categories: [{ id: 15, name: 'Kitchen' }],
            tags: [{ id: 3, name: 'Ceramic' }],
            images: [{ id: 9, src: 'https://store.example.com/mug.jpg', alt: 'Mug' }],
          },
        ],
        200,
        { 'x-wp-total': '1', 'x-wp-totalpages': '1' },
      ),
    );

    const page = await connector.fetchProducts(makeSession(true), null);
    expect(page.nextCursor).toBeNull();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      externalId: '300',
      title: 'Remote Mug',
      variants: [
        expect.objectContaining({
          sku: 'MUG-01',
          barcode: '0000000000099',
          price: '12.50',
          available: 9,
          weightGrams: 350,
        }),
      ],
    });

    // OrderSource read-only check
    http.expect(
      HttpMethod.Get,
      /\/wp-json\/wc\/v3\/orders\/901/,
      jsonResponse({
        id: 901,
        number: '901',
        status: 'processing',
        currency: 'USD',
        date_created_gmt: '2026-11-25T10:00:00',
        date_modified_gmt: '2026-11-25T10:05:00',
        total: '25.00',
        line_items: [
          {
            id: 1,
            name: 'Remote Mug',
            product_id: 300,
            variation_id: 0,
            quantity: 2,
            sku: 'MUG-01',
            price: '12.50',
          },
        ],
      }),
    );
    const order = await orders.fetchOrder(makeSession(true), '901');
    expect(order?.name).toBe('#901');
    expect(order?.lines[0]?.quantity).toBe(2);

    // Webhook HMAC-SHA256 verification
    const rawBody = Buffer.from(JSON.stringify({ id: 901, status: 'processing' }), 'utf8');
    const secret = 'whsec_test_secret';
    const validSig = createHmac('sha256', secret).update(rawBody).digest('base64');
    const verifiedEvent = verifyWooCommerceWebhook(
      {
        rawBody,
        headers: {
          'x-wc-webhook-signature': validSig,
          'x-wc-webhook-topic': 'order.updated',
          'x-wc-webhook-source': 'https://store.example.com/',
          'x-wc-webhook-delivery-id': 'deliv-1',
        },
      },
      secret,
    );
    expect(verifiedEvent).toMatchObject({
      kind: ChannelWebhookKind.OrderChanged,
      externalAccountId: 'store.example.com',
      resourceId: '901',
      deliveryId: 'deliv-1',
    });

    const tampered = verifyWooCommerceWebhook(
      {
        rawBody,
        headers: {
          'x-wc-webhook-signature': 'invalid-signature',
          'x-wc-webhook-topic': 'order.updated',
        },
      },
      secret,
    );
    expect(tampered).toBeNull();
    http.assertDone();
  });

  it('decodes HTML entities in WooCommerce category and attribute names', async () => {
    const { http, connector } = createHarness();
    http.expect(
      HttpMethod.Get,
      /\/wp-json\/wc\/v3\/products\/categories/,
      jsonResponse([
        { id: 80, name: 'Health &amp; Fitness', slug: 'health-fitness', parent: 0, count: 9 },
        { id: 81, name: 'Men&#039;s Gear', slug: 'mens-gear', parent: 80, count: 2 },
      ]),
    );

    const categories = await connector.suggestCategories(makeSession(false), 'Health & Fitness');
    expect(categories).toEqual([
      { id: '80', name: 'Health & Fitness' },
      { id: '81', name: "Health & Fitness > Men's Gear" },
    ]);
    http.assertDone();
  });
});
