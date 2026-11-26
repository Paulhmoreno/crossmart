import { Injectable } from '@nestjs/common';
import { FixedDecimal } from '@crossmart/common';
import { z } from 'zod';
import { MercadoLibreApiClient } from '../api/mercadolibre-api.client.js';
import {
  MERCADOLIBRE_SITE_LISTING_PRICES_PATH,
  MERCADOLIBRE_USER_FREE_SHIPPING_PATH,
  MercadoLibrePathParam,
  MercadoLibreQueryParam,
} from '../mercadolibre.constants.js';
import { MercadoLibreShippingPolicy } from '../mercadolibre.enums.js';
import type { MercadoLibreSettings } from '../mercadolibre-settings.js';
import type { MercadoLibreSiteId } from '../mercadolibre-site.js';

const MANDATORY_DISCOUNT_TYPE = 'mandatory';

const listingPriceEntrySchema = z
  .object({
    listing_type_id: z.string().min(1),
    listing_type_name: z.string().min(1),
    sale_fee_amount: z.number().nonnegative().default(0),
    sale_fee_details: z
      .object({
        percentage_fee: z.number().nonnegative().optional(),
        fixed_fee: z.number().nonnegative().optional(),
        gross_amount: z.number().nonnegative().optional(),
      })
      .loose()
      .optional(),
    free_relist: z.boolean().optional(),
  })
  .loose();

const listingPricesResponseSchema = z.array(listingPriceEntrySchema);

const freeShippingOptionSchema = z
  .object({
    coverage: z
      .object({
        all_country: z
          .object({
            list_cost: z.number().nonnegative().optional(),
            cost: z.number().nonnegative().optional(),
            currency_id: z.string().optional(),
            discount: z
              .object({
                rate: z.number().nonnegative().optional(),
                type: z.string().optional(),
                promoted_amount: z.number().nonnegative().optional(),
              })
              .loose()
              .optional(),
          })
          .loose()
          .optional(),
      })
      .loose()
      .optional(),
  })
  .loose();

export interface MercadoLibreListingFeeQuote {
  listingTypeId: string;
  listingTypeName: string;
  saleFeeAmount: number;
  percentageFee: number | null;
  fixedFee: number | null;
}

export interface MercadoLibreShippingCostQuote {
  available: boolean;
  listCost: number | null;
  sellerCost: number | null;
  discountRate: number | null;
  promotedAmount: number | null;
  currencyId: string | null;
  mandatoryFreeShipping: boolean;
  errorReason: string | null;
}

export interface MercadoLibreShippingDecision {
  freeShipping: boolean;
  reason: string;
  mandatory: boolean;
}

/**
 * Evaluates the store's commercial shipping policy using ONLY real API shipping cost data.
 * Never invents costs or assumes free shipping when a quote fails.
 */
export function evaluateMercadoLibreShippingPolicy(
  settings: Pick<
    MercadoLibreSettings,
    'shippingPolicy' | 'autoFreeShippingMinPrice' | 'autoFreeShippingMaxCostPercent'
  >,
  price: number,
  quote: MercadoLibreShippingCostQuote | null,
): MercadoLibreShippingDecision {
  if (quote?.mandatoryFreeShipping) {
    return { freeShipping: true, reason: 'mandatory_by_channel', mandatory: true };
  }
  const policy = settings.shippingPolicy ?? MercadoLibreShippingPolicy.BuyerPays;
  if (policy === MercadoLibreShippingPolicy.BuyerPays) {
    return { freeShipping: false, reason: 'policy_buyer_pays', mandatory: false };
  }
  if (policy === MercadoLibreShippingPolicy.FreeShipping) {
    return { freeShipping: true, reason: 'policy_free_shipping', mandatory: false };
  }
  return evaluateAutomaticPolicy(settings, price, quote);
}

function evaluateAutomaticPolicy(
  settings: Pick<
    MercadoLibreSettings,
    'autoFreeShippingMinPrice' | 'autoFreeShippingMaxCostPercent'
  >,
  price: number,
  quote: MercadoLibreShippingCostQuote | null,
): MercadoLibreShippingDecision {
  if (!quote || !quote.available || quote.sellerCost === null) {
    return { freeShipping: false, reason: 'shipping_quote_unavailable', mandatory: false };
  }
  const minPrice = settings.autoFreeShippingMinPrice;
  if (typeof minPrice === 'number' && price < minPrice) {
    return { freeShipping: false, reason: 'below_min_price_threshold', mandatory: false };
  }
  if (quote.sellerCost === 0) {
    return { freeShipping: true, reason: 'fully_covered_by_channel', mandatory: false };
  }
  const maxCostPct = settings.autoFreeShippingMaxCostPercent;
  if (typeof maxCostPct !== 'number') {
    return { freeShipping: false, reason: 'max_cost_percent_not_configured', mandatory: false };
  }
  const priceDec = FixedDecimal.parse(String(price));
  const costDec = FixedDecimal.parse(String(quote.sellerCost));
  const maxPctDec = FixedDecimal.parse(String(maxCostPct));
  if (!priceDec || !costDec || !maxPctDec || !priceDec.greaterThan(FixedDecimal.ZERO)) {
    return { freeShipping: false, reason: 'exceeds_max_cost_percent', mandatory: false };
  }
  const costPct = costDec.dividedBy(priceDec).times(FixedDecimal.ONE_HUNDRED);
  if (!costPct.greaterThan(maxPctDec)) {
    return { freeShipping: true, reason: 'within_auto_cost_threshold', mandatory: false };
  }
  return { freeShipping: false, reason: 'exceeds_max_cost_percent', mandatory: false };
}

/** Queries real Mercado Libre listing fees and account-specific shipping costs (read-only). */
@Injectable()
export class MercadoLibreCommercialClient {
  constructor(private readonly api: MercadoLibreApiClient) {}

  async readListingFees(params: {
    accessToken: string;
    siteId: MercadoLibreSiteId;
    currencyId: string;
    categoryId: string;
    price: number;
  }): Promise<MercadoLibreListingFeeQuote[]> {
    const entries = await this.api.get(
      {
        accessToken: params.accessToken,
        path: MERCADOLIBRE_SITE_LISTING_PRICES_PATH,
        params: { [MercadoLibrePathParam.SiteId]: params.siteId },
        query: {
          [MercadoLibreQueryParam.Price]: String(params.price),
          [MercadoLibreQueryParam.CategoryId]: params.categoryId,
          [MercadoLibreQueryParam.CurrencyId]: params.currencyId,
        },
      },
      listingPricesResponseSchema,
    );
    return entries.map((entry) => ({
      listingTypeId: entry.listing_type_id,
      listingTypeName: entry.listing_type_name,
      saleFeeAmount: entry.sale_fee_amount,
      percentageFee: entry.sale_fee_details?.percentage_fee ?? null,
      fixedFee: entry.sale_fee_details?.fixed_fee ?? null,
    }));
  }

  /**
   * Reads real effective free-shipping cost for the seller's account, including reputation
   * discounts/bonuses. Never fabricates costs when unavailable.
   */
  async readShippingCost(params: {
    accessToken: string;
    userId: string;
    categoryId: string;
    listingTypeId: string;
    price: number;
    currencyId: string;
    condition: string;
  }): Promise<MercadoLibreShippingCostQuote> {
    try {
      const response = await this.api.get(
        {
          accessToken: params.accessToken,
          path: MERCADOLIBRE_USER_FREE_SHIPPING_PATH,
          params: { [MercadoLibrePathParam.UserId]: params.userId },
          query: {
            [MercadoLibreQueryParam.CategoryId]: params.categoryId,
            [MercadoLibreQueryParam.ListingTypeId]: params.listingTypeId,
            [MercadoLibreQueryParam.ItemPrice]: String(params.price),
            [MercadoLibreQueryParam.CurrencyId]: params.currencyId,
            [MercadoLibreQueryParam.Condition]: params.condition,
          },
        },
        freeShippingOptionSchema,
      );
      const coverage = response.coverage?.all_country;
      if (!coverage || typeof coverage.cost !== 'number') {
        return unavailableQuote('no_coverage_cost_returned');
      }
      return {
        available: true,
        listCost: coverage.list_cost ?? coverage.cost,
        sellerCost: coverage.cost,
        discountRate: coverage.discount?.rate ?? null,
        promotedAmount: coverage.discount?.promoted_amount ?? null,
        currencyId: coverage.currency_id ?? params.currencyId,
        mandatoryFreeShipping: coverage.discount?.type === MANDATORY_DISCOUNT_TYPE,
        errorReason: null,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'shipping_lookup_failed';
      return unavailableQuote(reason);
    }
  }
}

function unavailableQuote(errorReason: string): MercadoLibreShippingCostQuote {
  return {
    available: false,
    listCost: null,
    sellerCost: null,
    discountRate: null,
    promotedAmount: null,
    currencyId: null,
    mandatoryFreeShipping: false,
    errorReason,
  };
}
