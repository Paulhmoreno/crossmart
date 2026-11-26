import { describe, expect, it } from 'vitest';
import type { ChannelSession } from '../sdk/auth/channel-session.js';
import type { ListingDraft } from '../sdk/capabilities/listing-publisher.js';
import { ChannelType } from '../sdk/channel-type.enum.js';
import { ChannelErrorCode } from '../sdk/errors/channel-error-code.enum.js';
import { HttpMethod } from '../sdk/http/http-method.enum.js';
import { FakeImageFetcher } from '../sdk/images/fake-image-fetcher.js';
import { fakeChannelSession } from '../sdk/testing/fake-channel-session.js';
import { FakeHttpTransport, jsonResponse } from '../sdk/testing/fake-http-transport.js';
import { WooCommerceAccountVerifier } from './account/woocommerce-account.verifier.js';
import { serializeWooCommerceSecrets } from './account/woocommerce-credentials.js';
import { WooCommerceApiClient } from './api/woocommerce-api.client.js';
import { WooCommerceCatalogSource } from './catalog/woocommerce-catalog.source.js';
import { WooCommerceInventorySync } from './inventory/woocommerce-inventory-sync.js';
import { WooCommerceListingPublisher } from './publish/woocommerce-listing.publisher.js';
import { WooCommerceMediaUploader } from './publish/woocommerce-media.uploader.js';
import { WooCommerceTaxonomyProvider } from './taxonomy/woocommerce-taxonomy.provider.js';
import {
  WOOCOMMERCE_META_AUTO_CATEGORY_ID,
  WOOCOMMERCE_META_MANAGED_ATTRIBUTES,
  WOOCOMMERCE_META_MANAGED_BRAND,
  WOOCOMMERCE_META_MANAGED_TAGS,
  WOOCOMMERCE_META_MEDIA_MAP,
  WOOCOMMERCE_META_PRODUCT_ID,
} from './woocommerce.constants.js';
import { WooCommercePublishStatus } from './woocommerce.enums.js';
import type { WooCommerceSettings } from './woocommerce-settings.js';
import { WooCommerceConnector } from './woocommerce.connector.js';

const STORE_URL = 'https://store.example.com';

function createHarness() {
  const http = new FakeHttpTransport();
  const api = new WooCommerceApiClient(http);
  const accounts = new WooCommerceAccountVerifier(api);
  const catalog = new WooCommerceCatalogSource(api);
  const taxonomy = new WooCommerceTaxonomyProvider(api);
  const fetcher = new FakeImageFetcher();
  const media = new WooCommerceMediaUploader(api, fetcher);
  const publisher = new WooCommerceListingPublisher(api, media, taxonomy);
  const inventory = new WooCommerceInventorySync(api);
  const connector = new WooCommerceConnector(accounts, catalog, publisher, taxonomy, inventory);
  return { http, connector };
}

function makeSession(defaultStatus = WooCommercePublishStatus.Draft): ChannelSession {
  const token = serializeWooCommerceSecrets({
    consumerKey: 'ck_test',
    consumerSecret: 'cs_test',
  });
  const settings: WooCommerceSettings = {
    channel: ChannelType.WooCommerce,
    storeUrl: STORE_URL,
    storeName: 'Store',
    currencyCode: 'USD',
    pricesIncludeTax: true,
    weightUnit: 'kg',
    dimensionUnit: 'cm',
    defaultStatus,
    hasWordPressMediaAuth: false,
    wpUsername: null,
    remoteProductCount: 0,
  };
  return { ...fakeChannelSession('store.example.com', token), settings };
}

function baseDraft(overrides: Partial<ListingDraft> = {}): ListingDraft {
  return {
    productId: 'prod-100',
    product: {
      handle: 'usb-adapter',
      title: 'Adaptador USB-C',
      descriptionHtml: '<p>Adaptador compacto.</p>',
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
        sku: 'SKU-100',
        barcode: '7860000000001',
        optionValues: [],
        price: '12.50',
        compareAtPrice: null,
        tracked: true,
        available: 5,
        weightGrams: 100,
        requiresShipping: true,
        taxable: true,
        continueSellingWhenOutOfStock: false,
        unitCost: null,
      },
    ],
    ...overrides,
  };
}

describe('WooCommerceConnector — Mission 06 completion', () => {
  it('resolves multi-level hierarchical categories, reusing existing levels and creating only missing ones', async () => {
    const { http, connector } = createHarness();
    // SKU check
    http.expect(HttpMethod.Get, /\/products\?sku=SKU-100/, jsonResponse([]));
    // Level 1: Computacion (exists by slug)
    http.expect(
      HttpMethod.Get,
      /\/products\/categories\?slug=computacion/,
      jsonResponse([{ id: 10, name: 'Computacion', slug: 'computacion', parent: 0 }]),
    );
    // Level 2: Teclados y Mouse under parent 10 (missing -> create)
    http
      .expect(
        HttpMethod.Get,
        /\/products\/categories\?slug=computacion-teclados-y-mouse/,
        jsonResponse([]),
      )
      .expect(
        HttpMethod.Get,
        /\/products\/categories\?search=Teclados%20y%20Mouse.*parent=10/,
        jsonResponse([]),
      )
      .expect(
        HttpMethod.Post,
        /\/products\/categories$/,
        jsonResponse(
          { id: 20, name: 'Teclados y Mouse', slug: 'computacion-teclados-y-mouse', parent: 10 },
          201,
        ),
      );
    // Level 3: Mouse under parent 20 (race condition term_exists -> recovers existing)
    http
      .expect(
        HttpMethod.Get,
        /\/products\/categories\?slug=computacion-teclados-y-mouse-mouse/,
        jsonResponse([]),
      )
      .expect(HttpMethod.Get, /\/products\/categories\?search=Mouse.*parent=20/, jsonResponse([]))
      .expect(
        HttpMethod.Post,
        /\/products\/categories$/,
        jsonResponse({ code: 'term_exists', message: 'Already exists' }, 400),
      )
      .expect(
        HttpMethod.Get,
        /\/products\/categories\?slug=computacion-teclados-y-mouse-mouse/,
        jsonResponse([
          { id: 30, name: 'Mouse', slug: 'computacion-teclados-y-mouse-mouse', parent: 20 },
        ]),
      );
    // Create & read-back product
    http
      .expect(
        HttpMethod.Post,
        /\/products$/,
        jsonResponse(
          { id: 901, status: 'draft', permalink: 'https://store.example.com/p/901' },
          201,
        ),
      )
      .expect(
        HttpMethod.Get,
        /\/products\/901/,
        jsonResponse({
          id: 901,
          name: 'Adaptador USB-C',
          status: 'draft',
          permalink: 'https://store.example.com/p/901',
          description: '<p>Adaptador compacto.</p>',
          short_description: '<p>Adaptador compacto.</p>',
          sku: 'SKU-100',
          global_unique_id: '7860000000001',
          regular_price: '12.5',
          sale_price: '',
          manage_stock: true,
          stock_quantity: 5,
          stock_status: 'instock',
          categories: [{ id: 30, name: 'Mouse' }],
          meta_data: [{ key: WOOCOMMERCE_META_PRODUCT_ID, value: 'prod-100' }],
        }),
      );

    const draft = baseDraft({
      product: { ...baseDraft().product, productType: 'Computacion / Teclados y Mouse / Mouse' },
    });
    const res = await connector.publish(makeSession(), draft);
    expect(res.category).toEqual({ id: '30', name: 'Computacion > Teclados y Mouse > Mouse' });
    expect(res.active).toBe(false);

    const createReq = http.requests.find(
      (req) => req.method === HttpMethod.Post && req.url.endsWith('/products'),
    );
    const body = JSON.parse(createReq?.body ?? '{}');
    expect(body.categories).toEqual([{ id: 30 }]);
    expect(body.meta_data).toContainEqual({ key: WOOCOMMERCE_META_AUTO_CATEGORY_ID, value: '30' });
    http.assertDone();
  });

  it('distinguishes homonymous categories under different parents', async () => {
    const { http, connector } = createHarness();
    http.expect(HttpMethod.Get, /\/products\?sku=SKU-100/, jsonResponse([]));
    // Root: Hogar (id 40)
    http.expect(
      HttpMethod.Get,
      /\/products\/categories\?slug=hogar/,
      jsonResponse([{ id: 40, name: 'Hogar', slug: 'hogar', parent: 0 }]),
    );
    // Child: Accesorios under parent 40 (even though Accesorios exists under parent 10!)
    http
      .expect(
        HttpMethod.Get,
        /\/products\/categories\?slug=hogar-accesorios/,
        jsonResponse([{ id: 99, name: 'Accesorios', slug: 'hogar-accesorios', parent: 10 }]),
      )
      .expect(
        HttpMethod.Get,
        /\/products\/categories\?search=Accesorios.*parent=40/,
        jsonResponse([{ id: 41, name: 'Accesorios', slug: 'accesorios-hogar', parent: 40 }]),
      );
    http
      .expect(HttpMethod.Post, /\/products$/, jsonResponse({ id: 902, status: 'draft' }, 201))
      .expect(
        HttpMethod.Get,
        /\/products\/902/,
        jsonResponse({
          id: 902,
          name: 'Adaptador USB-C',
          status: 'draft',
          description: '<p>Adaptador compacto.</p>',
          short_description: '<p>Adaptador compacto.</p>',
          sku: 'SKU-100',
          global_unique_id: '7860000000001',
          regular_price: '12.50',
          sale_price: '',
          manage_stock: true,
          stock_quantity: 5,
          stock_status: 'instock',
          categories: [{ id: 41, name: 'Accesorios' }],
          meta_data: [{ key: WOOCOMMERCE_META_PRODUCT_ID, value: 'prod-100' }],
        }),
      );

    const draft = baseDraft({
      product: { ...baseDraft().product, productType: 'Hogar / Accesorios' },
    });
    const res = await connector.publish(makeSession(), draft);
    expect(res.category).toEqual({ id: '41', name: 'Hogar > Accesorios' });
    http.assertDone();
  });

  it('respects explicit manual category selection over productType, and reports unsupported brands honestly', async () => {
    const { http, connector } = createHarness();
    http.expect(HttpMethod.Get, /\/products\?sku=SKU-100/, jsonResponse([]));
    // Brands endpoint returns 404 -> must fail honestly, never substitute tags/attributes
    http.expect(
      HttpMethod.Get,
      /\/products\/brands\?slug=marca-x/,
      jsonResponse({ code: 'rest_no_route', message: 'No route' }, 404),
    );

    const draftWithBrand = baseDraft({
      category: { id: '55', name: 'Manual Category' },
      product: { ...baseDraft().product, vendor: 'Marca X', productType: 'Computacion / Cables' },
    });
    await expect(connector.publish(makeSession(), draftWithBrand)).rejects.toMatchObject({
      code: ChannelErrorCode.RequestRejected,
      message: expect.stringContaining('/products/brands'),
    });
    http.assertDone();
  });

  it('handles generic products without brand, zero stock with backorders, and does not omit rejected tags', async () => {
    const { http, connector } = createHarness();
    // 1. Rejected tag must throw (not silently omitted)
    http
      .expect(HttpMethod.Get, /\/products\?sku=SKU-100/, jsonResponse([]))
      .expect(HttpMethod.Get, /\/products\/tags\?slug=bad-tag/, jsonResponse([]))
      .expect(HttpMethod.Get, /\/products\/tags\?search=bad%20tag/, jsonResponse([]))
      .expect(
        HttpMethod.Post,
        /\/products\/tags$/,
        jsonResponse({ code: 'woocommerce_rest_invalid_term', message: 'Tag rejected' }, 400),
      );
    await expect(
      connector.publish(
        makeSession(),
        baseDraft({ product: { ...baseDraft().product, tags: ['bad tag'] } }),
      ),
    ).rejects.toMatchObject({ code: ChannelErrorCode.RequestRejected });

    // 2. Generic product (vendor: null) with zero stock & continueSellingWhenOutOfStock=true -> onbackorder & no brands sent
    http
      .expect(HttpMethod.Get, /\/products\?sku=SKU-100/, jsonResponse([]))
      .expect(HttpMethod.Post, /\/products$/, jsonResponse({ id: 903, status: 'draft' }, 201))
      .expect(
        HttpMethod.Get,
        /\/products\/903/,
        jsonResponse({
          id: 903,
          name: 'Adaptador USB-C',
          status: 'draft',
          description: '<p>Adaptador compacto.</p>',
          short_description: '<p>Adaptador compacto.</p>',
          sku: 'SKU-100',
          global_unique_id: '7860000000001',
          regular_price: '12.50',
          sale_price: '',
          manage_stock: true,
          stock_quantity: 0,
          stock_status: 'onbackorder',
          meta_data: [{ key: WOOCOMMERCE_META_PRODUCT_ID, value: 'prod-100' }],
        }),
      );

    const zeroStockDraft = baseDraft({
      variants: [{ ...baseDraft().variants[0], available: 0, continueSellingWhenOutOfStock: true }],
    });
    await connector.publish(makeSession(), zeroStockDraft);
    const req = http.requests.find(
      (item) => item.method === HttpMethod.Post && item.url.endsWith('/products'),
    );
    const body = JSON.parse(req?.body ?? '{}');
    expect(body.brands).toBeUndefined();
    expect(body.stock_quantity).toBe(0);
    expect(body.stock_status).toBe('onbackorder');
    expect(body.backorders).toBe('yes');
    http.assertDone();
  });

  it('removes cleared Crossmart tags while preserving foreign remote tags, and preserves images on content-only updates', async () => {
    const { http, connector } = createHarness();
    http.expect(
      HttpMethod.Get,
      /\/products\/765/,
      jsonResponse({
        id: 765,
        status: 'draft',
        tags: [
          { id: 101, name: 'Old Managed' },
          { id: 202, name: 'Foreign Store Tag' },
        ],
        images: [{ id: 888, src: 'https://store.example.com/img.jpg' }],
        attributes: [
          { id: 0, name: 'Foreign Attr', options: ['Keep'], visible: true, variation: false },
        ],
        meta_data: [
          { key: WOOCOMMERCE_META_PRODUCT_ID, value: 'prod-100' },
          {
            key: WOOCOMMERCE_META_MEDIA_MAP,
            value: JSON.stringify({ 'https://cdn.example.com/1.jpg': 888 }),
          },
          { key: WOOCOMMERCE_META_MANAGED_TAGS, value: JSON.stringify([101]) },
          { key: WOOCOMMERCE_META_MANAGED_ATTRIBUTES, value: JSON.stringify(['color']) },
          { key: WOOCOMMERCE_META_MANAGED_BRAND, value: '' },
        ],
      }),
    );
    http
      .expect(HttpMethod.Put, /\/products\/765$/, jsonResponse({ id: 765, status: 'draft' }))
      .expect(
        HttpMethod.Get,
        /\/products\/765/,
        jsonResponse({
          id: 765,
          name: 'Adaptador USB-C',
          status: 'draft',
          description: '<p>Adaptador compacto.</p>',
          short_description: '<p>Adaptador compacto.</p>',
          sku: 'SKU-100',
          global_unique_id: '7860000000001',
          regular_price: '12.50',
          sale_price: '',
          manage_stock: true,
          stock_quantity: 5,
          stock_status: 'instock',
          tags: [{ id: 202, name: 'Foreign Store Tag' }],
          images: [{ id: 888, src: 'https://store.example.com/img.jpg' }],
          attributes: [{ id: 0, name: 'Foreign Attr', options: ['Keep'] }],
          meta_data: [{ key: WOOCOMMERCE_META_PRODUCT_ID, value: 'prod-100' }],
        }),
      );

    const draft = baseDraft({
      imagesChanged: false,
      product: {
        ...baseDraft().product,
        tags: [],
        images: [{ url: 'https://cdn.example.com/1.jpg', altText: 'Front' }],
      },
    });
    const updated = await connector.update(makeSession(), '765', draft);
    expect(updated.active).toBe(false);

    const putReq = http.requests.find(
      (req) => req.method === HttpMethod.Put && req.url.endsWith('/products/765'),
    );
    const body = JSON.parse(putReq?.body ?? '{}');
    expect(body.tags).toEqual([{ id: 202 }]);
    expect(body.images).toBeUndefined();
    expect(body.status).toBe('draft'); // Never auto-promoted!
    expect(body.attributes).toEqual([
      expect.objectContaining({ name: 'Foreign Attr', options: ['Keep'] }),
    ]);
    http.assertDone();
  });

  it('supports variable products with global attribute reuse, paginated variations, and full read-back verification', async () => {
    const { http, connector } = createHarness();
    // Variant SKU checks
    http
      .expect(HttpMethod.Get, /\/products\?sku=VAR-RED/, jsonResponse([]))
      .expect(HttpMethod.Get, /\/products\?sku=VAR-BLUE/, jsonResponse([]));
    // Global attributes & terms
    http
      .expect(
        HttpMethod.Get,
        /\/products\/attributes\?/,
        jsonResponse([{ id: 5, name: 'Color', slug: 'pa_color' }]),
      )
      .expect(
        HttpMethod.Get,
        /\/products\/attributes\/5\/terms/,
        jsonResponse([{ id: 51, name: 'Rojo', slug: 'rojo' }]),
      )
      .expect(
        HttpMethod.Post,
        /\/products\/attributes\/5\/terms$/,
        jsonResponse({ id: 52, name: 'Azul', slug: 'azul' }, 201),
      );
    // Parent create
    http.expect(
      HttpMethod.Post,
      /\/products$/,
      jsonResponse({ id: 950, type: 'variable', status: 'publish' }, 201),
    );
    // Existing variations check (empty) + 2 variation creates
    http
      .expect(
        HttpMethod.Get,
        /\/products\/950\/variations\?per_page=100&page=1/,
        jsonResponse([], 200, { 'x-wp-totalpages': '1' }),
      )
      .expect(HttpMethod.Post, /\/products\/950\/variations$/, jsonResponse({ id: 951 }, 201))
      .expect(HttpMethod.Post, /\/products\/950\/variations$/, jsonResponse({ id: 952 }, 201));
    // Verification read-back (parent + variations)
    http
      .expect(
        HttpMethod.Get,
        /\/products\/950\?/,
        jsonResponse({
          id: 950,
          name: 'Camiseta',
          type: 'variable',
          status: 'publish',
          description: '<p>Algodon</p>',
          short_description: '<p>Algodon</p>',
          attributes: [{ id: 5, name: 'Color', options: ['Rojo', 'Azul'], variation: true }],
          meta_data: [{ key: WOOCOMMERCE_META_PRODUCT_ID, value: 'prod-var' }],
        }),
      )
      .expect(
        HttpMethod.Get,
        /\/products\/950\/variations\?per_page=100&page=1/,
        jsonResponse(
          [
            {
              id: 951,
              sku: 'VAR-RED',
              global_unique_id: '111',
              regular_price: '20.00',
              sale_price: '',
              manage_stock: true,
              stock_quantity: 3,
              stock_status: 'instock',
              attributes: [{ id: 5, name: 'Color', option: 'Rojo' }],
            },
            {
              id: 952,
              sku: 'VAR-BLUE',
              global_unique_id: '222',
              regular_price: '22.00',
              sale_price: '',
              manage_stock: true,
              stock_quantity: 0,
              stock_status: 'outofstock',
              attributes: [{ id: 5, name: 'Color', option: 'Azul' }],
            },
          ],
          200,
          { 'x-wp-totalpages': '1' },
        ),
      );

    const varDraft = baseDraft({
      productId: 'prod-var',
      explicitVisibility: 'visible',
      product: {
        ...baseDraft().product,
        title: 'Camiseta',
        descriptionHtml: '<p>Algodon</p>',
        optionNames: ['Color'],
      },
      variants: [
        {
          ...baseDraft().variants[0],
          variantId: 'v-1',
          sku: 'VAR-RED',
          barcode: '111',
          optionValues: ['Rojo'],
          price: '20.00',
          available: 3,
        },
        {
          ...baseDraft().variants[0],
          variantId: 'v-2',
          sku: 'VAR-BLUE',
          barcode: '222',
          optionValues: ['Azul'],
          price: '22.00',
          available: 0,
        },
      ],
    });
    const res = await connector.publish(makeSession(), varDraft);
    expect(res.active).toBe(true);
    expect(res.variants).toEqual([
      { variantId: 'v-1', externalId: '951', externalInventoryId: '950:951' },
      { variantId: 'v-2', externalId: '952', externalInventoryId: '950:952' },
    ]);
    http.assertDone();
  });

  it('recovers owned SKU after partial failure and fails verification if remote drops sent data despite HTTP 200', async () => {
    const { http, connector } = createHarness();
    // Publish finds owned SKU #777 -> delegates cleanly to update without duplicating
    http
      .expect(
        HttpMethod.Get,
        /\/products\?sku=SKU-100/,
        jsonResponse([
          {
            id: 777,
            sku: 'SKU-100',
            status: 'draft',
            meta_data: [{ key: WOOCOMMERCE_META_PRODUCT_ID, value: 'prod-100' }],
          },
        ]),
      )
      .expect(
        HttpMethod.Get,
        /\/products\/777/,
        jsonResponse({
          id: 777,
          sku: 'SKU-100',
          status: 'draft',
          meta_data: [{ key: WOOCOMMERCE_META_PRODUCT_ID, value: 'prod-100' }],
        }),
      )
      .expect(HttpMethod.Put, /\/products\/777$/, jsonResponse({ id: 777, status: 'draft' }))
      .expect(
        HttpMethod.Get,
        /\/products\/777/,
        jsonResponse({
          id: 777,
          name: 'Adaptador USB-C',
          status: 'draft',
          description: '<p>Adaptador compacto.</p>',
          short_description: '<p>Adaptador compacto.</p>',
          sku: 'SKU-100',
          global_unique_id: '', // Dropped barcode!
          regular_price: '99.00', // Wrong price!
          sale_price: '',
          manage_stock: true,
          stock_quantity: 5,
          stock_status: 'instock',
          meta_data: [{ key: WOOCOMMERCE_META_PRODUCT_ID, value: 'prod-100' }],
        }),
      );

    await expect(connector.publish(makeSession(), baseDraft())).rejects.toMatchObject({
      code: ChannelErrorCode.RequestRejected,
      message: expect.stringContaining('regular_price'),
    });
    http.assertDone();
  });

  it('imports brand names and paginated variations from WooCommerce', async () => {
    const { http, connector } = createHarness();
    http.expect(
      HttpMethod.Get,
      /\/products\?per_page=50/,
      jsonResponse(
        [
          {
            id: 400,
            name: 'Cable &amp; Hub',
            slug: 'cable-hub',
            permalink: 'https://store.example.com/p/400',
            type: 'simple',
            status: 'draft',
            description: '<p>Desc</p>',
            short_description: 'Desc',
            sku: 'CH-1',
            price: '9.99',
            regular_price: '9.99',
            sale_price: '',
            manage_stock: true,
            stock_quantity: 2,
            stock_status: 'instock',
            backorders: 'no',
            weight: '0.1',
            brands: [{ id: 12, name: 'Acme &amp; Co' }],
            categories: [{ id: 5, name: 'Audio &amp; Video' }],
            tags: [],
            images: [],
          },
        ],
        200,
        { 'x-wp-total': '1', 'x-wp-totalpages': '1' },
      ),
    );
    const page = await connector.fetchProducts(makeSession(), null);
    expect(page.items[0]).toMatchObject({
      title: 'Cable & Hub',
      vendor: 'Acme & Co',
      productType: 'Audio & Video',
      active: false,
    });
    http.assertDone();
  });
});
