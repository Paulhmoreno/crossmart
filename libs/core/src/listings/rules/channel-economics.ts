import { currencyFractionDigits, FixedDecimal } from '@crossmart/common';
import { PRICE_MAX_FRACTION_DIGITS } from '../../channels/channels.constants.js';

const ONE = FixedDecimal.fromInteger(1);
const PERCENT_DISPLAY_DIGITS = 2;
const ZERO_STRING = '0';

/** Explicit knowledge state for any economic cost input. Missing costs are never treated as zero. */
export type CostKnowledgeStatus = 'known' | 'confirmed_zero' | 'unknown';

export interface EconomicCostInput {
  status: CostKnowledgeStatus;
  /** Exact decimal string in the channel currency when status is `known`. */
  amount?: string | null;
}

export interface EconomicTaxInput {
  /** Effective tax rate percentage (e.g. `'15'` for 15%, `'0'` for 0%). Null when unknown. */
  ratePercent?: string | null;
  /** True when `publicPrice` already includes tax; false when tax is added on top. Null when unknown. */
  priceIncludesTax?: boolean | null;
}

export interface ChannelEconomicsInput {
  currencyCode: string;
  /** Gross/public sale price as a decimal string in the channel's currency. */
  publicPrice: string;
  tax?: EconomicTaxInput | null;
  unitCost?: EconomicCostInput | null;
  channelFee?: EconomicCostInput | null;
  sellerShippingCost?: EconomicCostInput | null;
  otherCharges?: EconomicCostInput | null;
  /** Optional operator-configured informational target margin (% over net sale). Never blocks publishing. */
  targetMarginPercent?: string | null;
}

export type EconomicsCompleteness = 'complete' | 'partial' | 'unavailable';

export interface EconomicCostEntry {
  status: CostKnowledgeStatus;
  amount: string | null;
}

export interface ChannelEconomicsResult {
  currencyCode: string;
  publicPrice: string;
  /** Tax-excluded sale price (base imponible sin impuesto). Null when tax treatment is unknown. */
  netSalePrice: string | null;
  taxAmount: string | null;
  taxRatePercent: string | null;
  priceIncludesTax: boolean | null;
  unitCost: EconomicCostEntry;
  channelFee: EconomicCostEntry;
  sellerShippingCost: EconomicCostEntry;
  otherCharges: EconomicCostEntry;
  /** `netSalePrice - unitCost - channelFee - sellerShippingCost - otherCharges` when complete. */
  estimatedProfit: string | null;
  /** `(estimatedProfit / netSalePrice) * 100` when complete and `netSalePrice > 0`. */
  estimatedMarginPercent: string | null;
  targetMarginPercent: string | null;
  /** Informational comparison against `targetMarginPercent`; null if not configured or incomplete. */
  belowTargetMargin: boolean | null;
  completeness: EconomicsCompleteness;
  missingInputs: string[];
}

interface ResolvedCost {
  entry: EconomicCostEntry;
  decimal: FixedDecimal | null;
}

interface ResolvedTax {
  netSale: FixedDecimal | null;
  taxAmount: FixedDecimal | null;
  ratePercent: string | null;
  priceIncludesTax: boolean | null;
}

function moneyDigits(currencyCode: string): number {
  return Math.min(currencyFractionDigits(currencyCode), PRICE_MAX_FRACTION_DIGITS);
}

function resolveCost(
  input: EconomicCostInput | null | undefined,
  key: string,
  digits: number,
  missing: string[],
): ResolvedCost {
  if (!input || input.status === 'unknown') {
    missing.push(key);
    return { entry: { status: 'unknown', amount: null }, decimal: null };
  }
  if (input.status === 'confirmed_zero') {
    return {
      entry: { status: 'confirmed_zero', amount: FixedDecimal.ZERO.toFixed(digits) },
      decimal: FixedDecimal.ZERO,
    };
  }
  const parsed = input.amount ? FixedDecimal.parse(input.amount) : null;
  if (!parsed || parsed.isNegative()) {
    missing.push(key);
    return { entry: { status: 'unknown', amount: null }, decimal: null };
  }
  return { entry: { status: 'known', amount: parsed.toFixed(digits) }, decimal: parsed };
}

function resolveTax(
  publicPrice: FixedDecimal,
  tax: EconomicTaxInput | null | undefined,
  missing: string[],
): ResolvedTax {
  const rate =
    tax?.ratePercent !== undefined && tax?.ratePercent !== null
      ? FixedDecimal.parse(tax.ratePercent)
      : null;
  if (!rate || rate.isNegative()) {
    missing.push('tax');
    return { netSale: null, taxAmount: null, ratePercent: null, priceIncludesTax: null };
  }
  if (rate.isZero()) {
    return {
      netSale: publicPrice,
      taxAmount: FixedDecimal.ZERO,
      ratePercent: rate.toString(),
      priceIncludesTax: tax?.priceIncludesTax ?? true,
    };
  }
  if (typeof tax?.priceIncludesTax !== 'boolean') {
    missing.push('tax_treatment');
    return { netSale: null, taxAmount: null, ratePercent: rate.toString(), priceIncludesTax: null };
  }
  if (tax.priceIncludesTax) {
    const divisor = ONE.plus(rate.dividedBy(FixedDecimal.ONE_HUNDRED));
    const netSale = publicPrice.dividedBy(divisor);
    return {
      netSale,
      taxAmount: publicPrice.minus(netSale),
      ratePercent: rate.toString(),
      priceIncludesTax: true,
    };
  }
  const taxAmount = publicPrice.times(rate).dividedBy(FixedDecimal.ONE_HUNDRED);
  return { netSale: publicPrice, taxAmount, ratePercent: rate.toString(), priceIncludesTax: false };
}

function resolveCompleteness(
  missing: readonly string[],
  tax: ResolvedTax,
  costs: readonly ResolvedCost[],
): EconomicsCompleteness {
  if (missing.length === 0) return 'complete';
  const anyKnownCost = costs.some((cost) => cost.entry.status !== 'unknown');
  if (tax.netSale === null && !anyKnownCost) return 'unavailable';
  return 'partial';
}

function computeProfitAndMargin(
  netSale: FixedDecimal | null,
  costs: readonly ResolvedCost[],
  digits: number,
): { profit: string | null; marginDecimal: FixedDecimal | null; marginText: string | null } {
  if (!netSale || costs.some((cost) => cost.decimal === null)) {
    return { profit: null, marginDecimal: null, marginText: null };
  }
  const totalCost = costs.reduce(
    (sum, cost) => sum.plus(cost.decimal ?? FixedDecimal.ZERO),
    FixedDecimal.ZERO,
  );
  const profit = netSale.minus(totalCost);
  if (!netSale.greaterThan(FixedDecimal.ZERO)) {
    return { profit: profit.toFixed(digits), marginDecimal: null, marginText: null };
  }
  const margin = profit.dividedBy(netSale).times(FixedDecimal.ONE_HUNDRED);
  return {
    profit: profit.toFixed(digits),
    marginDecimal: margin,
    marginText: margin.toFixed(PERCENT_DISPLAY_DIGITS),
  };
}

/**
 * Channel-neutral economic calculation using exact `FixedDecimal` arithmetic.
 * Extracts tax from gross price when tax-included, computes margin over net sale price
 * (excluding tax), and never substitutes zero for unknown fees, shipping, or product cost.
 */
export function calculateChannelEconomics(input: ChannelEconomicsInput): ChannelEconomicsResult {
  const digits = moneyDigits(input.currencyCode);
  const publicPrice = FixedDecimal.of(input.publicPrice);
  const missing: string[] = [];

  const tax = resolveTax(publicPrice, input.tax, missing);
  const unitCost = resolveCost(input.unitCost, 'unit_cost', digits, missing);
  const channelFee = resolveCost(input.channelFee, 'channel_fee', digits, missing);
  const shipping = resolveCost(input.sellerShippingCost, 'seller_shipping_cost', digits, missing);
  const other = resolveCost(
    input.otherCharges ?? { status: 'confirmed_zero', amount: ZERO_STRING },
    'other_charges',
    digits,
    missing,
  );

  const primaryCosts = [unitCost, channelFee, shipping];
  const allCosts = [...primaryCosts, other];
  const { profit, marginDecimal, marginText } = computeProfitAndMargin(
    tax.netSale,
    allCosts,
    digits,
  );
  const target =
    input.targetMarginPercent !== undefined && input.targetMarginPercent !== null
      ? FixedDecimal.parse(input.targetMarginPercent)
      : null;

  return {
    currencyCode: input.currencyCode,
    publicPrice: publicPrice.toFixed(digits),
    netSalePrice: tax.netSale ? tax.netSale.toFixed(digits) : null,
    taxAmount: tax.taxAmount ? tax.taxAmount.toFixed(digits) : null,
    taxRatePercent: tax.ratePercent,
    priceIncludesTax: tax.priceIncludesTax,
    unitCost: unitCost.entry,
    channelFee: channelFee.entry,
    sellerShippingCost: shipping.entry,
    otherCharges: other.entry,
    estimatedProfit: profit,
    estimatedMarginPercent: marginText,
    targetMarginPercent: target ? target.toString() : null,
    belowTargetMargin: target && marginDecimal ? marginDecimal.lessThan(target) : null,
    completeness: resolveCompleteness(missing, tax, primaryCosts),
    missingInputs: missing,
  };
}

/**
 * Extracts real tax rate and price-inclusion treatment from ERP `sourceMetadata.taxDetails`.
 * Never guesses tax rates from tax display names; returns null when structured tax data is absent.
 */
export function extractTaxFromSourceMetadata(sourceMetadata: unknown): EconomicTaxInput | null {
  if (!sourceMetadata || typeof sourceMetadata !== 'object' || Array.isArray(sourceMetadata)) {
    return null;
  }
  const rawDetails = (sourceMetadata as Record<string, unknown>).taxDetails;
  if (!Array.isArray(rawDetails)) return null;
  if (rawDetails.length === 0) {
    return { ratePercent: ZERO_STRING, priceIncludesTax: true };
  }
  const entries = rawDetails.filter(isPercentTaxRecord);
  if (entries.length === 0) return null;

  const totalRate = entries.reduce((sum, entry) => {
    const parsed = FixedDecimal.parse(String(entry.amount));
    return parsed && !parsed.isNegative() ? sum.plus(parsed) : sum;
  }, FixedDecimal.ZERO);

  const inclusions = new Set(entries.map((entry) => entry.priceInclude));
  const priceIncludesTax = inclusions.size === 1 ? entries[0]!.priceInclude : null;
  return { ratePercent: totalRate.toString(), priceIncludesTax };
}

interface PercentTaxRecord {
  amount: number;
  amountType?: string;
  priceInclude: boolean;
}

function isPercentTaxRecord(value: unknown): value is PercentTaxRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const validType = record.amountType === undefined || record.amountType === 'percent';
  return (
    validType &&
    typeof record.amount === 'number' &&
    Number.isFinite(record.amount) &&
    typeof record.priceInclude === 'boolean'
  );
}
