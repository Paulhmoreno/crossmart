import { Injectable } from '@nestjs/common';
import type { ChannelSession } from '../../sdk/auth/channel-session.js';
import type { ChannelPage } from '../../sdk/capabilities/catalog.types.js';
import type {
  ExternalOrder,
  ExternalOrderLine,
  OrderSource,
} from '../../sdk/capabilities/order-source.js';
import { HttpMethod } from '../../sdk/http/http-method.enum.js';
import { wooCommerceAccount } from '../account/woocommerce-credentials.js';
import { WooCommerceApiClient } from '../api/woocommerce-api.client.js';
import type { WooOrder } from '../api/woocommerce-api.types.js';

const FIRST_PAGE = 1;
const ORDERS_PER_PAGE = 50;
const DECIMAL_PLACES = 2;
const CANCELLED_STATUSES = new Set(['cancelled', 'refunded', 'failed', 'trash']);
const FULFILLED_STATUSES = new Set(['completed']);

function formatAmount(raw: number | string | undefined): string {
  const numeric = Number(raw ?? 0);
  return Number.isFinite(numeric) ? numeric.toFixed(DECIMAL_PLACES) : '0.00';
}

function parseUtcDate(raw: string): Date {
  const normalized = raw.endsWith('Z') ? raw : `${raw}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

export function mapWooOrder(order: WooOrder): ExternalOrder {
  const cancelled = CANCELLED_STATUSES.has(order.status);
  const fulfilled = FULFILLED_STATUSES.has(order.status);
  const lines: ExternalOrderLine[] = (order.line_items ?? []).map((item) => ({
    externalId: String(item.id),
    externalVariantId: item.variation_id > 0 ? String(item.variation_id) : String(item.product_id),
    sku: item.sku?.trim() || null,
    title: item.name,
    quantity: Math.max(0, Math.floor(item.quantity)),
    fulfilledQuantity: fulfilled ? Math.max(0, Math.floor(item.quantity)) : 0,
    unitPrice: formatAmount(item.price),
  }));

  return {
    externalId: String(order.id),
    name: `#${order.number || order.id}`,
    placedAt: parseUtcDate(order.date_created_gmt),
    updatedAt: parseUtcDate(order.date_modified_gmt || order.date_created_gmt),
    cancelled,
    currencyCode: (order.currency || 'USD').toUpperCase(),
    total: formatAmount(order.total),
    lines,
  };
}

/**
 * Read-only WooCommerce order reader implementing Crossmart's `OrderSource` contract.
 * Note: intentionally NOT enabled in `WooCommerceConnector.capabilities` during Phase 2 so
 * automatic order ingestion and stock deductions stay disabled until Odoo/Crossmart/WooCommerce
 * reconciliation rules are validated.
 */
@Injectable()
export class WooCommerceOrderSource implements OrderSource {
  constructor(private readonly api: WooCommerceApiClient) {}

  async fetchOrders(
    session: ChannelSession,
    updatedSince: Date,
    cursor: string | null,
  ): Promise<ChannelPage<ExternalOrder>> {
    const { account } = await wooCommerceAccount(session);
    const page = cursor
      ? Math.max(FIRST_PAGE, Number.parseInt(cursor, 10) || FIRST_PAGE)
      : FIRST_PAGE;
    const params = new URLSearchParams({
      per_page: String(ORDERS_PER_PAGE),
      page: String(page),
      orderby: 'modified',
      order: 'asc',
      modified_after: updatedSince.toISOString(),
      dates_are_gmt: 'true',
    });
    const response = await this.api.request<WooOrder[]>(
      account,
      HttpMethod.Get,
      `/orders?${params.toString()}`,
    );
    const rows = Array.isArray(response.data) ? response.data : [];
    const totalPages = Number.parseInt(response.headers['x-wp-totalpages'] ?? '1', 10) || 1;
    return {
      items: rows.map(mapWooOrder),
      nextCursor: page < totalPages && rows.length > 0 ? String(page + 1) : null,
    };
  }

  async fetchOrder(session: ChannelSession, externalId: string): Promise<ExternalOrder | null> {
    const { account } = await wooCommerceAccount(session);
    try {
      const response = await this.api.request<WooOrder>(
        account,
        HttpMethod.Get,
        `/orders/${externalId}`,
      );
      return response.data ? mapWooOrder(response.data) : null;
    } catch {
      return null;
    }
  }
}
