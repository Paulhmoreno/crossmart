import { Injectable } from '@nestjs/common';
import type { ChannelSession } from '../../sdk/auth/channel-session.js';
import type {
  InventoryQuantityUpdate,
  InventorySync,
  InventoryUpdateFailure,
} from '../../sdk/capabilities/inventory-sync.js';
import { HttpMethod } from '../../sdk/http/http-method.enum.js';
import { wooCommerceAccount } from '../account/woocommerce-credentials.js';
import { WooCommerceApiClient } from '../api/woocommerce-api.client.js';
import type { WooProduct, WooVariation } from '../api/woocommerce-api.types.js';
import {
  WOOCOMMERCE_INVENTORY_BATCH_SIZE,
  WOOCOMMERCE_INVENTORY_ID_SEPARATOR,
} from '../woocommerce.constants.js';

function inventoryPath(externalInventoryId: string): string {
  const [productId, variationId] = externalInventoryId.split(WOOCOMMERCE_INVENTORY_ID_SEPARATOR);
  if (variationId) {
    return `/products/${productId}/variations/${variationId}`;
  }
  return `/products/${productId}`;
}

/**
 * Syncs available stock quantities to WooCommerce products and variations without altering
 * commercial content or Odoo master fields.
 */
@Injectable()
export class WooCommerceInventorySync implements InventorySync {
  readonly maxBatchSize = WOOCOMMERCE_INVENTORY_BATCH_SIZE;

  constructor(private readonly api: WooCommerceApiClient) {}

  async setQuantities(
    session: ChannelSession,
    updates: readonly InventoryQuantityUpdate[],
  ): Promise<InventoryUpdateFailure[]> {
    const { account } = await wooCommerceAccount(session);
    const failures: InventoryUpdateFailure[] = [];

    for (const update of updates) {
      const available = Math.max(0, Math.floor(update.available));
      try {
        await this.api.request(account, HttpMethod.Put, inventoryPath(update.externalInventoryId), {
          manage_stock: true,
          stock_quantity: available,
          stock_status: available > 0 ? 'instock' : 'outofstock',
        });
      } catch (error) {
        failures.push({
          externalInventoryId: update.externalInventoryId,
          message:
            error instanceof Error ? error.message : 'Error al actualizar stock en WooCommerce',
        });
      }
    }

    return failures;
  }

  async readQuantities(
    session: ChannelSession,
    externalInventoryIds: readonly string[],
  ): Promise<Map<string, number>> {
    const { account } = await wooCommerceAccount(session);
    const quantities = new Map<string, number>();

    for (const id of externalInventoryIds) {
      try {
        const res = await this.api.request<WooProduct | WooVariation>(
          account,
          HttpMethod.Get,
          inventoryPath(id),
        );
        if (res.data?.manage_stock && typeof res.data.stock_quantity === 'number') {
          quantities.set(id, Math.max(0, Math.floor(res.data.stock_quantity)));
        }
      } catch {
        // Absent items are re-sent during reconciliation.
      }
    }

    return quantities;
  }
}
