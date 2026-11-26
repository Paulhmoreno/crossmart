import { calculateChannelEconomics, extractTaxFromSourceMetadata } from './channel-economics.js';

describe('calculateChannelEconomics', () => {
  it('computes exact net sale, tax, profit, and margin for the reference 15% VAT-included fixture (Classic & Premium)', () => {
    const base = {
      currencyCode: 'USD',
      publicPrice: '9.00',
      tax: { ratePercent: '15', priceIncludesTax: true },
      unitCost: { status: 'known' as const, amount: '3.73' },
      sellerShippingCost: { status: 'confirmed_zero' as const },
      targetMarginPercent: '30',
    };

    const classic = calculateChannelEconomics({
      ...base,
      channelFee: { status: 'known', amount: '0.90' },
    });
    expect(classic).toMatchObject({
      publicPrice: '9.00',
      netSalePrice: '7.83',
      taxAmount: '1.17',
      taxRatePercent: '15',
      priceIncludesTax: true,
      estimatedProfit: '3.20',
      estimatedMarginPercent: '40.84',
      targetMarginPercent: '30',
      belowTargetMargin: false,
      completeness: 'complete',
      missingInputs: [],
    });

    const premium = calculateChannelEconomics({
      ...base,
      channelFee: { status: 'known', amount: '1.08' },
    });
    expect(premium).toMatchObject({
      publicPrice: '9.00',
      netSalePrice: '7.83',
      taxAmount: '1.17',
      estimatedProfit: '3.02',
      estimatedMarginPercent: '38.54',
      belowTargetMargin: false,
      completeness: 'complete',
      missingInputs: [],
    });
  });

  it('supports different tax rates (12%, 21%), 0% VAT, and tax-excluded prices', () => {
    const vat12 = calculateChannelEconomics({
      currencyCode: 'USD',
      publicPrice: '11.20',
      tax: { ratePercent: '12', priceIncludesTax: true },
      unitCost: { status: 'known', amount: '5.00' },
      channelFee: { status: 'known', amount: '1.00' },
      sellerShippingCost: { status: 'confirmed_zero' },
    });
    expect(vat12).toMatchObject({
      netSalePrice: '10.00',
      taxAmount: '1.20',
      estimatedProfit: '4.00',
      estimatedMarginPercent: '40.00',
      completeness: 'complete',
    });

    const vat0 = calculateChannelEconomics({
      currencyCode: 'USD',
      publicPrice: '10.00',
      tax: { ratePercent: '0', priceIncludesTax: true },
      unitCost: { status: 'known', amount: '6.00' },
      channelFee: { status: 'known', amount: '1.00' },
      sellerShippingCost: { status: 'confirmed_zero' },
    });
    expect(vat0).toMatchObject({
      netSalePrice: '10.00',
      taxAmount: '0.00',
      estimatedProfit: '3.00',
      estimatedMarginPercent: '30.00',
      completeness: 'complete',
    });

    const taxExcluded = calculateChannelEconomics({
      currencyCode: 'USD',
      publicPrice: '10.00',
      tax: { ratePercent: '16', priceIncludesTax: false },
      unitCost: { status: 'known', amount: '5.00' },
      channelFee: { status: 'known', amount: '1.00' },
      sellerShippingCost: { status: 'confirmed_zero' },
    });
    expect(taxExcluded).toMatchObject({
      netSalePrice: '10.00',
      taxAmount: '1.60',
      priceIncludesTax: false,
      estimatedProfit: '4.00',
      estimatedMarginPercent: '40.00',
      completeness: 'complete',
    });
  });

  it('flags margin below target as informational without throwing', () => {
    const result = calculateChannelEconomics({
      currencyCode: 'USD',
      publicPrice: '11.50',
      tax: { ratePercent: '15', priceIncludesTax: true },
      unitCost: { status: 'known', amount: '7.50' },
      channelFee: { status: 'known', amount: '1.15' },
      sellerShippingCost: { status: 'confirmed_zero' },
      targetMarginPercent: '30',
    });
    expect(result).toMatchObject({
      netSalePrice: '10.00',
      estimatedProfit: '1.35',
      estimatedMarginPercent: '13.50',
      belowTargetMargin: true,
      completeness: 'complete',
    });
  });

  it('never substitutes zero for unknown fees, shipping, cost, or tax', () => {
    const partial = calculateChannelEconomics({
      currencyCode: 'USD',
      publicPrice: '9.00',
      tax: { ratePercent: '15', priceIncludesTax: true },
      unitCost: { status: 'known', amount: '3.73' },
      channelFee: { status: 'unknown' },
      sellerShippingCost: { status: 'unknown' },
    });
    expect(partial).toMatchObject({
      netSalePrice: '7.83',
      estimatedProfit: null,
      estimatedMarginPercent: null,
      belowTargetMargin: null,
      completeness: 'partial',
      missingInputs: ['channel_fee', 'seller_shipping_cost'],
    });
    expect(partial.channelFee).toEqual({ status: 'unknown', amount: null });
    expect(partial.sellerShippingCost).toEqual({ status: 'unknown', amount: null });

    const unavailable = calculateChannelEconomics({
      currencyCode: 'USD',
      publicPrice: '9.00',
    });
    expect(unavailable).toMatchObject({
      netSalePrice: null,
      estimatedProfit: null,
      estimatedMarginPercent: null,
      completeness: 'unavailable',
      missingInputs: ['tax', 'unit_cost', 'channel_fee', 'seller_shipping_cost'],
    });
  });
});

describe('extractTaxFromSourceMetadata', () => {
  it('reads real structured taxDetails and never guesses from tax names alone', () => {
    expect(
      extractTaxFromSourceMetadata({
        taxes: ['IVA 15%'],
        taxDetails: [
          { id: 1, name: 'IVA 15%', amount: 15, amountType: 'percent', priceInclude: true },
        ],
      }),
    ).toEqual({ ratePercent: '15', priceIncludesTax: true });

    expect(extractTaxFromSourceMetadata({ taxes: [], taxDetails: [] })).toEqual({
      ratePercent: '0',
      priceIncludesTax: true,
    });

    expect(extractTaxFromSourceMetadata({ taxes: ['IVA 15%'] })).toBeNull();
    expect(extractTaxFromSourceMetadata(null)).toBeNull();
  });
});
