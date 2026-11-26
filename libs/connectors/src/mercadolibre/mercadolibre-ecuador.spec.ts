import { ChannelErrorCode } from '../sdk/errors/channel-error-code.enum.js';
import { HttpMethod } from '../sdk/http/http-method.enum.js';
import { PublishRequirement } from '../sdk/publishing/publish-requirement.enum.js';
import { jsonResponse } from '../sdk/testing/fake-http-transport.js';
import {
  API,
  createMercadoLibreTestKit,
  descriptionUrl,
  draftVariant,
  ITEMS_URL,
  itemUrl,
  listingDraft,
  mercadoLibreSession,
  mercadoLibreSettings,
  PICTURES_UPLOAD_URL,
  USER_ID,
  VALIDATE_ITEMS_URL,
} from './mercadolibre.fixtures.js';
import {
  MercadoLibreListingType,
  MercadoLibreShippingMode,
  MercadoLibreShippingPolicy,
} from './mercadolibre.enums.js';
import { MercadoLibreSiteId } from './mercadolibre-site.js';
import {
  computeMercadoLibreEconomics,
  evaluateMercadoLibreShippingPolicy,
} from './publish/mercadolibre-commercial.client.js';
import {
  adaptMercadoLibreDescription,
  adaptMercadoLibreTitle,
} from './publish/mercadolibre-content.adapter.js';
import { resolveListingTypeId } from './publish/mercadolibre-item.mapper.js';
import {
  describeMercadoLibreModeration,
  isMercadoLibreItemLive,
} from './publish/mercadolibre-item.verifier.js';

const MEC_CATEGORY_ID = 'MEC1055';
const MEC_CATEGORY_URL = `${API}/categories/${MEC_CATEGORY_ID}`;
const MEC_ATTRIBUTES_URL = `${MEC_CATEGORY_URL}/attributes`;
const MEC_ITEM_ID = 'MEC900100200';

function mecSession(overrides = {}) {
  return mercadoLibreSession(
    mercadoLibreSettings({
      siteId: MercadoLibreSiteId.Ecuador,
      currencyCode: 'USD',
      defaultListingTypeId: MercadoLibreListingType.Classic,
      shippingMode: MercadoLibreShippingMode.Me2,
      localPickUp: true,
      warrantyType: 'Garantía del vendedor',
      warrantyTime: '6 meses',
      ...overrides,
    }),
  );
}

const MEC_LEAF_CATEGORY = {
  id: MEC_CATEGORY_ID,
  name: 'Accesorios',
  path_from_root: [
    { id: 'MEC1000', name: 'Tecnología' },
    { id: MEC_CATEGORY_ID, name: 'Accesorios' },
  ],
  children_categories: [],
  settings: {
    listing_allowed: true,
    max_title_length: 60,
    max_pictures_per_item: 10,
    minimum_price: 5,
    shipping_modes: ['me2', 'custom'],
  },
};

const MEC_ATTRIBUTES = [
  { id: 'BRAND', name: 'Marca', tags: { required: true }, value_type: 'string', values: [] },
  { id: 'MODEL', name: 'Modelo', tags: {}, value_type: 'string', values: [] },
  {
    id: 'EMPTY_GTIN_REASON',
    name: 'Motivo de GTIN vacío',
    tags: {},
    value_type: 'list',
    values: [{ id: '17055160', name: 'El producto no tiene código registrado' }],
  },
  { id: 'SELLER_PACKAGE_WEIGHT', name: 'Peso', tags: {}, value_type: 'number_unit', values: [] },
];

describe('Mercado Libre Ecuador (MEC) completion', () => {
  it('adapts titles and plain-text descriptions cleanly for Mercado Libre', () => {
    const draft = listingDraft();
    draft.product = {
      ...draft.product,
      vendor: 'Acme',
      title: '<b>Acme Acme</b> Taladro Inalámbrico 20V Profesional Compacto Extra Largo',
      descriptionHtml:
        '<h3>Características</h3><ul><li>Motor 20V</li><li>Visita https://acme.example.com</li></ul>' +
        '<p>WhatsApp: 0999999999</p><p>Email: ventas@acme.example.com</p><p>EAN: 7861234567890</p>',
    };

    const title = adaptMercadoLibreTitle(draft, 60);
    const description = adaptMercadoLibreDescription(draft);

    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.startsWith('Acme Taladro')).toBe(true);
    expect(description).toContain('Motor 20V');
    expect(description).not.toContain('https://');
    expect(description).not.toContain('WhatsApp');
    expect(description).not.toContain('ventas@acme.example.com');
    expect(description).not.toContain('EAN:');
  });

  it('rejects non-leaf categories and prices below the category minimum', async () => {
    const { connector, http } = createMercadoLibreTestKit();
    http.expect(
      HttpMethod.Get,
      MEC_CATEGORY_URL,
      jsonResponse({
        ...MEC_LEAF_CATEGORY,
        children_categories: [{ id: 'MEC9999', name: 'Subcategoría' }],
      }),
    );

    const draft = listingDraft({
      category: { id: MEC_CATEGORY_ID, name: 'Accesorios' },
      variants: [draftVariant({ price: '25.00' })],
    });
    await expect(connector.publish(mecSession(), draft)).rejects.toMatchObject({
      requirement: PublishRequirement.Category,
    });

    http.expect(HttpMethod.Get, MEC_CATEGORY_URL, jsonResponse(MEC_LEAF_CATEGORY));
    const cheapDraft = listingDraft({
      category: { id: MEC_CATEGORY_ID, name: 'Accesorios' },
      variants: [draftVariant({ price: '2.50' })],
    });
    await expect(connector.publish(mecSession(), cheapDraft)).rejects.toMatchObject({
      code: ChannelErrorCode.RequestRejected,
      message: expect.stringContaining('minimum (5)') as string,
    });
  });

  it('uploads local photos via /pictures/items/upload, links exact GTIN catalog, and sends MEC commercial terms', async () => {
    const { connector, http, imageFetcher } = createMercadoLibreTestKit();
    const localUrl = 'http://localhost:3300/uploads/product-photo-1.jpg';

    const createdItem = {
      id: MEC_ITEM_ID,
      seller_id: Number(USER_ID),
      category_id: MEC_CATEGORY_ID,
      listing_type_id: 'gold_special',
      price: 49.99,
      available_quantity: 5,
      status: 'active',
      sub_status: [],
      permalink: `https://articulo.mercadolibre.com.ec/${MEC_ITEM_ID}`,
      sold_quantity: 0,
      variations: [],
    };

    http
      .expect(HttpMethod.Get, MEC_CATEGORY_URL, jsonResponse(MEC_LEAF_CATEGORY))
      .expect(HttpMethod.Get, MEC_ATTRIBUTES_URL, jsonResponse(MEC_ATTRIBUTES))
      .expect(HttpMethod.Post, PICTURES_UPLOAD_URL, jsonResponse({ id: 'MLPIC-001' }))
      .expect(
        HttpMethod.Get,
        `${API}/users/${USER_ID}/items/search?seller_sku=SKU-MEC-1`,
        jsonResponse({ results: [] }),
      )
      .expect(
        HttpMethod.Get,
        `${API}/products/search?site_id=MEC&status=active&product_identifier=7861000000012&limit=5`,
        jsonResponse({
          results: [
            {
              id: 'MEC-CAT-99',
              attributes: [{ id: 'GTIN', value_name: '7861000000012' }],
            },
          ],
        }),
      )
      .expect(HttpMethod.Post, VALIDATE_ITEMS_URL, jsonResponse({}))
      .expect(HttpMethod.Post, ITEMS_URL, jsonResponse(createdItem))
      .expect(HttpMethod.Post, descriptionUrl(MEC_ITEM_ID), jsonResponse({ plain_text: 'ok' }))
      .expect(HttpMethod.Get, itemUrl(MEC_ITEM_ID), jsonResponse(createdItem))
      .expect(HttpMethod.Get, descriptionUrl(MEC_ITEM_ID), jsonResponse({ plain_text: 'ok' }));

    const draft = listingDraft({
      category: { id: MEC_CATEGORY_ID, name: 'Accesorios' },
      variants: [
        draftVariant({
          sku: 'SKU-MEC-1',
          barcode: '7861000000012',
          price: '49.99',
          available: 5,
          weightGrams: 1500,
        }),
      ],
      itemSpecifics: [
        { name: 'Modelo', values: ['PRO-20V'] },
        { name: 'Motivo de GTIN vacío', values: ['El producto no tiene código registrado'] },
      ],
    });
    draft.product = {
      ...draft.product,
      optionNames: [],
      images: [{ url: localUrl, altText: null }],
    };

    const published = await connector.publish(mecSession(), draft);

    expect(published.externalId).toBe(MEC_ITEM_ID);
    expect(published.active).toBe(true);
    expect(imageFetcher.fetched).toEqual([localUrl]);
    const postItem = http.requests.find(
      (req) => req.method === HttpMethod.Post && req.url === ITEMS_URL,
    );
    const payload = JSON.parse(postItem?.body ?? '{}') as Record<string, unknown>;
    expect(payload).toMatchObject({
      category_id: MEC_CATEGORY_ID,
      currency_id: 'USD',
      listing_type_id: 'gold_special',
      catalog_product_id: 'MEC-CAT-99',
      pictures: [{ id: 'MLPIC-001' }],
      shipping: { mode: 'me2', local_pick_up: true },
      sale_terms: [
        { id: 'WARRANTY_TYPE', value_name: 'Garantía del vendedor' },
        { id: 'WARRANTY_TIME', value_name: '6 meses' },
      ],
    });
    expect(payload.attributes).toEqual(
      expect.arrayContaining([
        {
          id: 'EMPTY_GTIN_REASON',
          value_id: '17055160',
          value_name: 'El producto no tiene código registrado',
        },
        { id: 'SELLER_PACKAGE_WEIGHT', value_name: '1.5 kg' },
      ]),
    );
    http.assertDone();
  });

  it('recovers an existing own open item by SKU instead of creating a duplicate', async () => {
    const { connector, http } = createMercadoLibreTestKit();
    const existingItem = {
      id: MEC_ITEM_ID,
      seller_id: Number(USER_ID),
      category_id: MEC_CATEGORY_ID,
      seller_custom_field: 'SKU-DUP-1',
      status: 'active',
      sub_status: [],
      permalink: `https://articulo.mercadolibre.com.ec/${MEC_ITEM_ID}`,
      sold_quantity: 0,
      variations: [],
    };
    http
      .expect(HttpMethod.Get, MEC_CATEGORY_URL, jsonResponse(MEC_LEAF_CATEGORY))
      .expect(HttpMethod.Get, MEC_ATTRIBUTES_URL, jsonResponse(MEC_ATTRIBUTES))
      .expect(
        HttpMethod.Get,
        `${API}/users/${USER_ID}/items/search?seller_sku=SKU-DUP-1`,
        jsonResponse({ results: [MEC_ITEM_ID] }),
      )
      .expect(HttpMethod.Get, itemUrl(MEC_ITEM_ID), jsonResponse(existingItem))
      .expect(HttpMethod.Get, itemUrl(MEC_ITEM_ID), jsonResponse(existingItem))
      .expect(HttpMethod.Put, itemUrl(MEC_ITEM_ID), jsonResponse(existingItem))
      .expect(
        HttpMethod.Put,
        `${descriptionUrl(MEC_ITEM_ID)}?api_version=2`,
        jsonResponse({ plain_text: 'ok' }),
      )
      .expect(HttpMethod.Get, itemUrl(MEC_ITEM_ID), jsonResponse(existingItem))
      .expect(HttpMethod.Get, descriptionUrl(MEC_ITEM_ID), jsonResponse({ plain_text: 'ok' }));

    const draft = listingDraft({
      category: { id: MEC_CATEGORY_ID, name: 'Accesorios' },
      variants: [draftVariant({ sku: 'SKU-DUP-1', barcode: null, price: '29.00' })],
    });
    draft.product = { ...draft.product, optionNames: [] };

    const published = await connector.publish(mecSession(), draft);

    expect(published.externalId).toBe(MEC_ITEM_ID);
    expect(http.requests.filter((req) => req.url === ITEMS_URL)).toHaveLength(0);
    http.assertDone();
  });

  it('never counts moderated, paused, or under_review items as live', () => {
    expect(
      isMercadoLibreItemLive({
        id: 'MEC1',
        status: 'active',
        sub_status: [],
        sold_quantity: 0,
        pictures: [],
        attributes: [],
        variations: [],
      }),
    ).toBe(true);
    expect(
      isMercadoLibreItemLive({
        id: 'MEC1',
        status: 'under_review',
        sub_status: [],
        sold_quantity: 0,
        pictures: [],
        attributes: [],
        variations: [],
      }),
    ).toBe(false);
    expect(
      isMercadoLibreItemLive({
        id: 'MEC1',
        status: 'paused',
        sub_status: [],
        sold_quantity: 0,
        pictures: [],
        attributes: [],
        variations: [],
      }),
    ).toBe(false);
    const moderated = {
      id: 'MEC1',
      status: 'active',
      sub_status: ['suspended'],
      sold_quantity: 0,
      pictures: [],
      attributes: [],
      variations: [],
    };
    expect(isMercadoLibreItemLive(moderated)).toBe(false);
    expect(describeMercadoLibreModeration(moderated)).toContain('suspended');
  });

  it('evaluates automatic shipping policy using only real quotes and computes economics accurately', () => {
    const autoSettings = {
      shippingPolicy: MercadoLibreShippingPolicy.Automatic,
      autoFreeShippingMinPrice: 25,
      autoFreeShippingMaxCostPercent: 12,
    };

    // Never assumes free when shipping quote fails/unavailable
    expect(
      evaluateMercadoLibreShippingPolicy(autoSettings, 40, {
        available: false,
        listCost: null,
        sellerCost: null,
        discountRate: null,
        promotedAmount: null,
        currencyId: null,
        mandatoryFreeShipping: false,
        errorReason: 'timeout',
      }),
    ).toMatchObject({ freeShipping: false, reason: 'shipping_quote_unavailable' });

    // Below min price threshold -> buyer pays
    expect(
      evaluateMercadoLibreShippingPolicy(autoSettings, 15, {
        available: true,
        listCost: 3,
        sellerCost: 1.5,
        discountRate: 50,
        promotedAmount: 1.5,
        currencyId: 'USD',
        mandatoryFreeShipping: false,
        errorReason: null,
      }),
    ).toMatchObject({ freeShipping: false, reason: 'below_min_price_threshold' });

    // Within min price and max cost % -> free shipping enabled
    expect(
      evaluateMercadoLibreShippingPolicy(autoSettings, 40, {
        available: true,
        listCost: 5,
        sellerCost: 3.5,
        discountRate: 30,
        promotedAmount: 1.5,
        currencyId: 'USD',
        mandatoryFreeShipping: false,
        errorReason: null,
      }),
    ).toMatchObject({ freeShipping: true, reason: 'within_auto_cost_threshold' });

    // Fully covered by ML (sellerCost === 0) above min price -> free shipping enabled
    expect(
      evaluateMercadoLibreShippingPolicy(autoSettings, 30, {
        available: true,
        listCost: 4,
        sellerCost: 0,
        discountRate: 100,
        promotedAmount: 4,
        currencyId: 'USD',
        mandatoryFreeShipping: false,
        errorReason: null,
      }),
    ).toMatchObject({ freeShipping: true, reason: 'fully_covered_by_channel' });

    // Internal profitability snapshot
    const econ = computeMercadoLibreEconomics({
      price: 50,
      unitCost: 22,
      saleFeeAmount: 7.5,
      sellerShippingCost: 3.5,
    });
    expect(econ).toEqual({
      price: 50,
      unitCost: 22,
      saleFeeAmount: 7.5,
      sellerShippingCost: 3.5,
      netProceeds: 39,
      estimatedMarginAmount: 17,
      estimatedMarginPercent: 34,
    });

    // Per-listing exception via native item specifics
    const draft = listingDraft({
      itemSpecifics: [{ name: 'Tipo de publicación', values: ['Premium'] }],
    });
    const settings = mercadoLibreSettings({
      defaultListingTypeId: 'bronze',
      availableListingTypes: [
        { id: 'bronze', name: 'Clásica' },
        { id: 'gold_pro', name: 'Premium' },
      ],
    });
    expect(resolveListingTypeId(draft, settings)).toBe('gold_pro');
  });
});
