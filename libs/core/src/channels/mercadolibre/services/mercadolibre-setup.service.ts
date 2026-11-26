import { Injectable } from '@nestjs/common';
import {
  type MercadoLibreListingSetupInput,
  type MercadoLibreSettings,
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

/**
 * Commercial listing setup for a connected Mercado Libre store: explicit listing type,
 * shipping mode, local pickup, warranty terms, and order import safety switch.
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
      shippingMode: input.shippingMode ?? null,
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

  private load(
    workspaceId: string,
    connectionId: string,
  ): Promise<ConnectionAccount<MercadoLibreSettings>> {
    return loadConnectionAccount(this.store, workspaceId, connectionId, MERCADOLIBRE_ACCOUNT);
  }
}
