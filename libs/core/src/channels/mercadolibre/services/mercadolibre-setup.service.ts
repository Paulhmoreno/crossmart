import { Injectable } from '@nestjs/common';
import {
  evaluateMercadoLibreShippingPolicy,
  type MercadoLibreListingFeeQuote,
  type MercadoLibreListingSetupInput,
  type MercadoLibreSettings,
  type MercadoLibreShippingCostQuote,
  type MercadoLibreShippingDecision,
  MercadoLibreConnector,
  isMercadoLibreSettings,
  resolveMercadoLibreListingType,
} from '@crossmart/connectors';
import { PrismaService } from '@crossmart/database';
import type { Actor } from '../../../activity/entities/actor.js';
import { ActivityAction } from '../../../activity/enums/activity-action.enum.js';
import { ActivityRecorder } from '../../../activity/services/activity-recorder.js';
import {
  calculateChannelEconomics,
  type ChannelEconomicsResult,
  type EconomicCostInput,
  type EconomicTaxInput,
  extractTaxFromSourceMetadata,
} from '../../../listings/rules/channel-economics.js';
import type { ChannelConnectionView } from '../../entities/channel-connection-view.js';
import { callChannel } from '../../rules/channel-http-error.js';
import {
  type ConnectionAccount,
  type ConnectionAccountKind,
  loadConnectionAccount,
  recordConnectionChange,
} from '../../rules/connection-account.js';
import { ChannelSessionFactory } from '../../services/channel-session.factory.js';
import { ConnectionAccountStore } from '../../services/connection-account.store.js';

const MERCADOLIBRE_ACCOUNT: ConnectionAccountKind<MercadoLibreSettings> = {
  isAccount: isMercadoLibreSettings,
  notThisChannel: 'This is not a Mercado Libre connection, or its account has not been read yet',
};
const ZERO_COST: EconomicCostInput = { status: 'confirmed_zero', amount: '0' };
const UNKNOWN_COST: EconomicCostInput = { status: 'unknown' };

export interface MercadoLibreCommercialPreviewInput {
  categoryId: string;
  price: number;
  unitCost?: number | null;
  listingTypeId?: string;
  productId?: string;
  taxRatePercent?: number | null;
  priceIncludesTax?: boolean | null;
  targetMarginPercent?: number | null;
}

export interface MercadoLibreCommercialPreviewResult {
  categoryId: string;
  currencyCode: string;
  listingTypeId: string;
  listingFees: MercadoLibreListingFeeQuote[];
  shippingQuote: MercadoLibreShippingCostQuote;
  shippingDecision: MercadoLibreShippingDecision;
  economics: ChannelEconomicsResult;
}

function toKnownCost(amount: number | string | null | undefined): EconomicCostInput {
  if (amount === null || amount === undefined) return UNKNOWN_COST;
  const numeric = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(numeric) || numeric < 0) return UNKNOWN_COST;
  return numeric === 0 ? ZERO_COST : { status: 'known', amount: String(amount) };
}

function resolveFeeCost(
  fees: readonly MercadoLibreListingFeeQuote[],
  listingTypeId: string,
): EconomicCostInput {
  const matched = fees.find((fee) => fee.listingTypeId === listingTypeId);
  if (!matched) return UNKNOWN_COST;
  return toKnownCost(matched.saleFeeAmount);
}

function resolveShippingCostEntry(
  decision: MercadoLibreShippingDecision,
  quote: MercadoLibreShippingCostQuote,
): EconomicCostInput {
  if (!decision.freeShipping) return ZERO_COST;
  if (!quote.available || quote.sellerCost === null) return UNKNOWN_COST;
  return toKnownCost(quote.sellerCost);
}

/**
 * Commercial listing setup for a connected Mercado Libre store: Clásica/Premium default,
 * commercial shipping policy (buyer pays, free, or automatic by price & real shipping cost),
 * local pickup, warranty terms, and order import safety switch.
 */
@Injectable()
export class MercadoLibreSetupService {
  constructor(
    private readonly store: ConnectionAccountStore,
    private readonly sessions: ChannelSessionFactory,
    private readonly mercadoLibre: MercadoLibreConnector,
    private readonly activity: ActivityRecorder,
    private readonly prisma: PrismaService,
  ) {}

  async saveListingSetup(
    workspaceId: string,
    connectionId: string,
    input: MercadoLibreListingSetupInput,
    actor: Actor,
  ): Promise<ChannelConnectionView> {
    const { connection, settings } = await this.load(workspaceId, connectionId);
    const account: MercadoLibreSettings = {
      ...settings,
      defaultListingTypeId: input.defaultListingTypeId ?? null,
      shippingPolicy: input.shippingPolicy ?? null,
      autoFreeShippingMinPrice: input.autoFreeShippingMinPrice ?? null,
      autoFreeShippingMaxCostPercent: input.autoFreeShippingMaxCostPercent ?? null,
      shippingMode: input.shippingMode ?? settings.shippingMode ?? null,
      localPickUp: input.localPickUp ?? null,
      warrantyType: input.warrantyType?.trim() || null,
      warrantyTime: input.warrantyTime?.trim() || null,
      importOrders: input.importOrders ?? settings.importOrders ?? false,
    };
    const saved = await this.store.saveAccount(workspaceId, connection, account);
    await recordConnectionChange(this.activity, workspaceId, actor, {
      action: ActivityAction.ChannelListingDefaultsUpdated,
      connection: saved,
    });
    return saved;
  }

  /** Refreshes available listing types from Mercado Libre for the connected site. */
  async refreshListingTypes(
    workspaceId: string,
    connectionId: string,
  ): Promise<ChannelConnectionView> {
    const { connection, settings } = await this.load(workspaceId, connectionId);
    const session = await this.sessions.open(workspaceId, connectionId);
    const availableListingTypes = await callChannel(() =>
      this.mercadoLibre.refreshListingTypes(session),
    );
    const account: MercadoLibreSettings = {
      ...settings,
      availableListingTypes,
    };
    return this.store.saveAccount(workspaceId, connection, account);
  }

  /** Read-only commercial preview: real ML fees, real shipping quote, policy decision, and margin. */
  async previewCommercialTerms(
    workspaceId: string,
    connectionId: string,
    input: MercadoLibreCommercialPreviewInput,
  ): Promise<MercadoLibreCommercialPreviewResult> {
    const { settings } = await this.load(workspaceId, connectionId);
    const session = await this.sessions.open(workspaceId, connectionId);
    const listingTypeId = resolveMercadoLibreListingType(settings, undefined, input.listingTypeId);
    const [{ listingFees, shippingQuote }, productFacts] = await Promise.all([
      callChannel(() =>
        this.mercadoLibre.readCommercialQuote(session, {
          categoryId: input.categoryId,
          price: input.price,
          listingTypeId,
        }),
      ),
      this.readProductFacts(workspaceId, input.productId),
    ]);
    const shippingDecision = evaluateMercadoLibreShippingPolicy(
      settings,
      input.price,
      shippingQuote,
    );
    const tax = this.resolveTaxInput(input, productFacts.tax);
    const unitCost =
      input.unitCost !== undefined ? toKnownCost(input.unitCost) : toKnownCost(productFacts.cost);
    const economics = calculateChannelEconomics({
      currencyCode: settings.currencyCode,
      publicPrice: String(input.price),
      tax,
      unitCost,
      channelFee: resolveFeeCost(listingFees, listingTypeId),
      sellerShippingCost: resolveShippingCostEntry(shippingDecision, shippingQuote),
      targetMarginPercent:
        input.targetMarginPercent !== undefined && input.targetMarginPercent !== null
          ? String(input.targetMarginPercent)
          : null,
    });
    return {
      categoryId: input.categoryId,
      currencyCode: settings.currencyCode,
      listingTypeId,
      listingFees,
      shippingQuote,
      shippingDecision,
      economics,
    };
  }

  private resolveTaxInput(
    input: MercadoLibreCommercialPreviewInput,
    productTax: EconomicTaxInput | null,
  ): EconomicTaxInput | null {
    if (input.taxRatePercent !== undefined) {
      return {
        ratePercent: input.taxRatePercent !== null ? String(input.taxRatePercent) : null,
        priceIncludesTax: input.priceIncludesTax ?? null,
      };
    }
    return productTax;
  }

  private async readProductFacts(
    workspaceId: string,
    productId?: string,
  ): Promise<{ cost: string | null; tax: EconomicTaxInput | null }> {
    if (!productId) return { cost: null, tax: null };
    const product = await this.prisma.product.findFirst({
      where: { id: productId, workspaceId },
      select: {
        sourceMetadata: true,
        variants: {
          orderBy: { position: 'asc' },
          take: 1,
          select: { cost: true },
        },
      },
    });
    if (!product) return { cost: null, tax: null };
    const variantCost = product.variants[0]?.cost;
    return {
      cost: variantCost !== null && variantCost !== undefined ? variantCost.toString() : null,
      tax: extractTaxFromSourceMetadata(product.sourceMetadata),
    };
  }

  private load(
    workspaceId: string,
    connectionId: string,
  ): Promise<ConnectionAccount<MercadoLibreSettings>> {
    return loadConnectionAccount(this.store, workspaceId, connectionId, MERCADOLIBRE_ACCOUNT);
  }
}
