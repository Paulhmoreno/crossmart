import { HttpMethod } from '../../sdk/http/http-method.enum.js';
import type { HttpRequest } from '../../sdk/http/http-transport.js';
import { PublishRequirement } from '../../sdk/publishing/publish-requirement.enum.js';
import { jsonResponse } from '../../sdk/testing/fake-http-transport.js';
import { fixtureResponse } from '../../sdk/testing/fixtures.js';
import { MercadoLibreShippingPolicy } from '../mercadolibre.enums.js';
import {
  API,
  ATTRIBUTES_URL,
  CATEGORY,
  CATEGORY_URL,
  createMercadoLibreTestKit,
  descriptionUrl,
  draftVariant,
  FIXTURES,
  fixtureJson,
  ITEMS_URL,
  itemUrl,
  listingDraft,
  mercadoLibreSession,
  mercadoLibreSettings,
  USER_ID,
  VALIDATE_ITEMS_URL,
} from '../mercadolibre.fixtures.js';
import { MercadoLibreSiteId } from '../mercadolibre-site.js';
import { evaluateMercadoLibreShippingPolicy } from './mercadolibre-commercial.client.js';
import { resolveMercadoLibreListingType } from './mercadolibre-item.mapper.js';

const FREE_SHIPPING_URL = `${API}/users/${USER_ID}/shipping_options/free?category_id=MLA1055&listing_type_id=gold_special&item_price=100&currency_id=ARS&condition=new`;

function body(request: HttpRequest | undefined): Record<string, unknown> {
  return JSON.parse(request?.body ?? '{}') as Record<string, unknown>;
}

function ownedFixture(name: string, overrides: Record<string, unknown> = {}) {
  const item = fixtureJson<Record<string, unknown>>(name);
  return { ...item, seller_id: Number(USER_ID), category_id: CATEGORY.id, ...overrides };
}

describe('resolveMercadoLibreListingType', () => {
  it('resolves Ecuador (MEC) and Mexico (MLM) listing types from real account metadata without hardcoding', () => {
    const mec = mercadoLibreSettings({
      siteId: MercadoLibreSiteId.Ecuador,
      currencyCode: 'USD',
      availableListingTypes: [
        { id: 'free', name: 'Gratuita' },
        { id: 'bronze', name: 'Clásica' },
        { id: 'gold_pro', name: 'Premium' },
      ],
    });
    expect(resolveMercadoLibreListingType(mec)).toBe('bronze');
    expect(resolveMercadoLibreListingType({ ...mec, defaultListingTypeId: 'gold_pro' })).toBe(
      'gold_pro',
    );
    expect(
      resolveMercadoLibreListingType(mec, {
        itemSpecifics: [{ name: 'Tipo de publicación', values: ['Premium'] }],
      }),
    ).toBe('gold_pro');

    const mlm = mercadoLibreSettings({
      siteId: MercadoLibreSiteId.Mexico,
      currencyCode: 'MXN',
      availableListingTypes: [
        { id: 'gold_special', name: 'Clásica' },
        { id: 'gold_pro', name: 'Premium' },
      ],
    });
    expect(resolveMercadoLibreListingType(mlm)).toBe('gold_special');
  });

  it('refuses to invent a listing type when neither default nor availableListingTypes exist', () => {
    const empty = mercadoLibreSettings({
      defaultListingTypeId: null,
      availableListingTypes: [],
    });
    expect(() => resolveMercadoLibreListingType(empty)).toThrow(
      expect.objectContaining({ requirement: PublishRequirement.AccountSettings }),
    );
  });
});

describe('evaluateMercadoLibreShippingPolicy', () => {
  it('handles buyer_pays, free_shipping, unavailable quote, 100% covered, and mandatory free shipping', () => {
    expect(
      evaluateMercadoLibreShippingPolicy(
        { shippingPolicy: MercadoLibreShippingPolicy.BuyerPays },
        50,
        null,
      ),
    ).toEqual({ freeShipping: false, reason: 'policy_buyer_pays', mandatory: false });

    expect(
      evaluateMercadoLibreShippingPolicy(
        { shippingPolicy: MercadoLibreShippingPolicy.FreeShipping },
        50,
        null,
      ),
    ).toEqual({ freeShipping: true, reason: 'policy_free_shipping', mandatory: false });

    expect(
      evaluateMercadoLibreShippingPolicy(
        {
          shippingPolicy: MercadoLibreShippingPolicy.Automatic,
          autoFreeShippingMaxCostPercent: 10,
        },
        50,
        {
          available: false,
          listCost: null,
          sellerCost: null,
          discountRate: null,
          promotedAmount: null,
          currencyId: null,
          mandatoryFreeShipping: false,
          errorReason: '403',
        },
      ),
    ).toEqual({ freeShipping: false, reason: 'shipping_quote_unavailable', mandatory: false });

    expect(
      evaluateMercadoLibreShippingPolicy(
        { shippingPolicy: MercadoLibreShippingPolicy.Automatic, autoFreeShippingMinPrice: 20 },
        50,
        {
          available: true,
          listCost: 5,
          sellerCost: 0,
          discountRate: 100,
          promotedAmount: 5,
          currencyId: 'USD',
          mandatoryFreeShipping: false,
          errorReason: null,
        },
      ),
    ).toEqual({ freeShipping: true, reason: 'fully_covered_by_channel', mandatory: false });

    expect(
      evaluateMercadoLibreShippingPolicy(
        { shippingPolicy: MercadoLibreShippingPolicy.BuyerPays },
        50,
        {
          available: true,
          listCost: 6,
          sellerCost: 3,
          discountRate: 50,
          promotedAmount: 3,
          currencyId: 'USD',
          mandatoryFreeShipping: true,
          errorReason: null,
        },
      ),
    ).toEqual({ freeShipping: true, reason: 'mandatory_by_channel', mandatory: true });
  });
});

describe('MercadoLibre shipping policy applied in publishers', () => {
  it('applies automatic shipping policy in SingleItemWriter for both validate and create', async () => {
    const { connector, http } = createMercadoLibreTestKit();
    http
      .expect(HttpMethod.Get, CATEGORY_URL, fixtureResponse(FIXTURES, 'category.json'))
      .expect(HttpMethod.Get, ATTRIBUTES_URL, fixtureResponse(FIXTURES, 'category-attributes.json'))
      .expect(
        HttpMethod.Get,
        FREE_SHIPPING_URL,
        jsonResponse({ coverage: { all_country: { list_cost: 10, cost: 5, currency_id: 'ARS' } } }),
      )
      .expect(HttpMethod.Post, VALIDATE_ITEMS_URL, jsonResponse({}))
      .expect(HttpMethod.Post, ITEMS_URL, fixtureResponse(FIXTURES, 'item-with-variations.json'))
      .expect(
        HttpMethod.Post,
        descriptionUrl('MLA657381404'),
        fixtureResponse(FIXTURES, 'description.json'),
      )
      .expect(
        HttpMethod.Get,
        itemUrl('MLA657381404'),
        jsonResponse(ownedFixture('item-with-variations.json')),
      )
      .expect(
        HttpMethod.Get,
        descriptionUrl('MLA657381404'),
        fixtureResponse(FIXTURES, 'description.json'),
      );

    const session = mercadoLibreSession(
      mercadoLibreSettings({
        shippingPolicy: MercadoLibreShippingPolicy.Automatic,
        autoFreeShippingMinPrice: 50,
        autoFreeShippingMaxCostPercent: 8,
      }),
    );

    await connector.publish(session, listingDraft());

    const validateBody = body(http.requests.find((req) => req.url === VALIDATE_ITEMS_URL));
    const createBody = body(http.requests.find((req) => req.url === ITEMS_URL));
    expect(validateBody.shipping).toEqual({ free_shipping: true });
    expect(createBody.shipping).toEqual({ free_shipping: true });
    http.assertDone();
  });

  it('applies shipping policy in UserProductWriter without altering shipping on routine updates', async () => {
    const { connector, http } = createMercadoLibreTestKit();
    const itemId = 'MLM2061397137';
    http
      .expect(HttpMethod.Get, CATEGORY_URL, fixtureResponse(FIXTURES, 'category.json'))
      .expect(HttpMethod.Get, ATTRIBUTES_URL, fixtureResponse(FIXTURES, 'category-attributes.json'))
      .expect(HttpMethod.Post, VALIDATE_ITEMS_URL, jsonResponse({}))
      .expect(
        HttpMethod.Post,
        ITEMS_URL,
        jsonResponse(ownedFixture('user-product-item.json', { id: itemId })),
      )
      .expect(
        HttpMethod.Post,
        descriptionUrl(itemId),
        fixtureResponse(FIXTURES, 'description.json'),
      )
      .expect(
        HttpMethod.Get,
        itemUrl(itemId),
        jsonResponse(ownedFixture('user-product-item.json', { id: itemId })),
      )
      .expect(
        HttpMethod.Get,
        descriptionUrl(itemId),
        fixtureResponse(FIXTURES, 'description.json'),
      );

    const session = mercadoLibreSession(
      mercadoLibreSettings({
        userProductSeller: true,
        shippingPolicy: MercadoLibreShippingPolicy.BuyerPays,
      }),
    );
    const singleDraft = listingDraft({ variants: [draftVariant()] });

    await connector.publish(session, singleDraft);

    const createBody = body(http.requests.find((req) => req.url === ITEMS_URL));
    expect(createBody.shipping).toEqual({ free_shipping: false });
    http.assertDone();
  });
});
