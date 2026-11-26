import { Injectable } from '@nestjs/common';
import {
  computeMercadoLibreEconomics,
  evaluateMercadoLibreShippingPolicy,
  type MercadoLibreEconomicsSnapshot,
  type MercadoLibreListingFeeQuote,
  type MercadoLibreListingSetupInput,
  type MercadoLibreSettings,
  type MercadoLibreShippingCostQuote,
  type MercadoLibreShippingDecision,
  MercadoLibreConnector,
  isMercadoLibreSettings,
} from '@crossmart/connectors';
import type { Actor } from '../../../activity/entities/actor.js';
import { ActivityAction } from '../../../activity/enums/activity-action.enum.js';
import { ActivityRecorder } from '../../../activity/services/activity-recorder.js';
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

export interface MercadoLibreCommercialPreviewInput {
  categoryId: string;
  price: number;
  unitCost?: number | null;
  listingTypeId?: string;
}

export interface MercadoLibreCommercialPreviewResult {
  categoryId: string;
  currencyCode: string;
  listingTypeId: string;
  listingFees: MercadoLibreListingFeeQuote[];
  shippingQuote: MercadoLibreShippingCostQuote;
  shippingDecision: MercadoLibreShippingDecision;
  economics: MercadoLibreEconomicsSnapshot;
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
    const listingTypeId = input.listingTypeId || settings.defaultListingTypeId || 'bronze';
    const { listingFees, shippingQuote } = await callChannel(() =>
      this.mercadoLibre.readCommercialQuote(session, {
        categoryId: input.categoryId,
        price: input.price,
        listingTypeId,
      }),
    );
    const shippingDecision = evaluateMercadoLibreShippingPolicy(
      settings,
      input.price,
      shippingQuote,
    );
    const matchedFee = listingFees.find((fee) => fee.listingTypeId === listingTypeId);
    const sellerShippingCost =
      shippingDecision.freeShipping && shippingQuote.available && shippingQuote.sellerCost !== null
        ? shippingQuote.sellerCost
        : 0;
    const economics = computeMercadoLibreEconomics({
      price: input.price,
      unitCost: input.unitCost ?? null,
      saleFeeAmount: matchedFee?.saleFeeAmount ?? 0,
      sellerShippingCost,
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

  private load(
    workspaceId: string,
    connectionId: string,
  ): Promise<ConnectionAccount<MercadoLibreSettings>> {
    return loadConnectionAccount(this.store, workspaceId, connectionId, MERCADOLIBRE_ACCOUNT);
  }
}
