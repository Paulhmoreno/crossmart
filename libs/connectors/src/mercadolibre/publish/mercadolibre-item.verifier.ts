import { Injectable } from '@nestjs/common';
import { ChannelErrorCode } from '../../sdk/errors/channel-error-code.enum.js';
import { MERCADOLIBRE_BLOCKING_SUB_STATUSES } from '../mercadolibre.constants.js';
import { MercadoLibreItemStatus } from '../mercadolibre.enums.js';
import { mercadoLibreError } from '../mercadolibre-errors.js';
import type { MercadoLibreSettings } from '../mercadolibre-settings.js';
import { MercadoLibreItemClient } from './mercadolibre-item.client.js';
import type { MercadoLibreItem } from './mercadolibre-item.types.js';

export interface MercadoLibreVerifiedItem {
  item: MercadoLibreItem;
  active: boolean;
  moderationReason: string | null;
}

/** True ONLY when Mercado Libre reports the item as active with no blocking moderation sub_status. */
export function isMercadoLibreItemLive(item: MercadoLibreItem): boolean {
  if (item.status !== MercadoLibreItemStatus.Active) return false;
  return !item.sub_status.some((flag) => MERCADOLIBRE_BLOCKING_SUB_STATUSES.has(flag));
}

/** Human-readable moderation or non-active status summary, or null when cleanly active. */
export function describeMercadoLibreModeration(item: MercadoLibreItem): string | null {
  const blockingFlags = item.sub_status.filter((flag) =>
    MERCADOLIBRE_BLOCKING_SUB_STATUSES.has(flag),
  );
  if (blockingFlags.length > 0) {
    return `Mercado Libre moderation (${item.status}: ${blockingFlags.join(', ')})`;
  }
  if (item.status === MercadoLibreItemStatus.UnderReview) {
    return 'Mercado Libre placed this item under review';
  }
  if (item.status === MercadoLibreItemStatus.PaymentRequired) {
    return 'Mercado Libre requires payment before activating this item';
  }
  return null;
}

/**
 * Post-publish / post-update read-back verifier: never trusts HTTP 200/201 alone.
 * Reads back `GET /items/{id}` and `GET /items/{id}/description` to verify ownership, category,
 * description persistence, and real live status.
 */
@Injectable()
export class MercadoLibreItemVerifier {
  constructor(private readonly items: MercadoLibreItemClient) {}

  async verify(
    accessToken: string,
    itemId: string,
    settings: MercadoLibreSettings,
    expectedCategoryId: string,
  ): Promise<MercadoLibreVerifiedItem> {
    const remote = await this.items.find(accessToken, itemId);
    if (!remote) {
      throw mercadoLibreError(
        ChannelErrorCode.RequestRejected,
        `Mercado Libre item ${itemId} could not be read back after publishing.`,
      );
    }
    if (remote.seller_id !== undefined && String(remote.seller_id) !== settings.userId) {
      throw mercadoLibreError(
        ChannelErrorCode.RequestRejected,
        `Mercado Libre item ${itemId} belongs to a different seller account.`,
      );
    }
    if (remote.category_id && remote.category_id !== expectedCategoryId) {
      throw mercadoLibreError(
        ChannelErrorCode.RequestRejected,
        `Mercado Libre item ${itemId} category mismatch (${remote.category_id} != ${expectedCategoryId}).`,
      );
    }
    await this.items.findDescription(accessToken, itemId);
    return {
      item: remote,
      active: isMercadoLibreItemLive(remote),
      moderationReason: describeMercadoLibreModeration(remote),
    };
  }
}
