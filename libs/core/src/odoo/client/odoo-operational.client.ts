import { createHmac } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';

export interface OdooOperationalAuth {
  url: string;
  connectionId: string;
  apiSecret: string;
}

export interface OdooModuleCapabilities {
  eventSync: boolean;
  incrementalReconcile: boolean;
  createPartner: boolean;
  createSaleOrder: boolean;
  reserveStock: boolean;
  releaseStock: boolean;
  cancelOrder: boolean;
  draftInvoice: boolean;
  postInvoice: boolean;
  writesSuspended: boolean;
}

export interface OdooModuleHealth {
  installed: boolean;
  moduleVersion: string | null;
  capabilities: OdooModuleCapabilities;
  outbox: {
    pending: number;
    failed: number;
    lastCommAt: string | null;
    lastSuccessAt: string | null;
  };
  error?: string;
}

export interface OdooPartnerResolveInput {
  name: string;
  vat?: string | null;
  externalRef?: string | null;
  email?: string | null;
  phone?: string | null;
  street?: string | null;
  city?: string | null;
  zip?: string | null;
}

export interface OdooPartnerResolveResult {
  ok: boolean;
  created: boolean;
  partnerId: number;
  name: string;
  vat: string | null;
  ref: string | null;
}

export interface OdooOrderUpsertInput {
  externalId: string;
  orderRef: string;
  channel: string;
  storeName: string;
  partnerId: number;
  warehouseId?: number | null;
  crossmartUrl?: string;
  reserveStock: boolean;
  lines: Array<{
    odooVariantId?: number | null;
    sku?: string | null;
    quantity: number;
    unitPrice: number;
  }>;
}

export interface OdooOrderOperationResult {
  ok: boolean;
  created?: boolean;
  alreadyCancelled?: boolean;
  alreadyMissing?: boolean;
  orderId?: number;
  orderName?: string;
  state?: string;
  reservationStatus?: string;
  orderedQty?: number;
  reservedQty?: number;
  delivered?: boolean;
  invoiceStatus?: string;
  invoiceIds?: number[];
  manualOverride?: boolean;
  error?: string;
  missingSkus?: string[];
}

export interface OdooInvoiceResult {
  ok: boolean;
  created?: boolean;
  invoiceId?: number | null;
  invoiceName?: string | null;
  state?: string | null;
  error?: string;
}

export const EMPTY_ODOO_CAPABILITIES: OdooModuleCapabilities = {
  eventSync: false,
  incrementalReconcile: false,
  createPartner: false,
  createSaleOrder: false,
  reserveStock: false,
  releaseStock: false,
  cancelOrder: false,
  draftInvoice: false,
  postInvoice: false,
  writesSuspended: false,
};

export function signCrossmartOdooPayload(
  secret: string,
  timestamp: string,
  body: string,
): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/**
 * Permission-gated operational client for Odoo's `crossmart_connector` module.
 * Completely separate from `OdooReadOnlyClient`: never executes generic XML-RPC/JSON-RPC
 * writes, always uses HMAC-SHA256 authentication, and respects capabilities granted by Odoo.
 */
@Injectable()
export class OdooOperationalClient {
  private readonly logger = new Logger(OdooOperationalClient.name);

  async getHealth(auth: OdooOperationalAuth): Promise<OdooModuleHealth> {
    try {
      const response = await this.request<{
        ok: boolean;
        moduleVersion?: string;
        capabilities?: Partial<OdooModuleCapabilities>;
        outbox?: OdooModuleHealth['outbox'];
        error?: string;
      }>(auth, 'GET', '/crossmart/api/v1/health');
      if (!response.ok) {
        return {
          installed: false,
          moduleVersion: null,
          capabilities: { ...EMPTY_ODOO_CAPABILITIES },
          outbox: { pending: 0, failed: 0, lastCommAt: null, lastSuccessAt: null },
          error: response.error ?? 'health_failed',
        };
      }
      return {
        installed: true,
        moduleVersion: response.moduleVersion ?? '18.0.1.0.0',
        capabilities: { ...EMPTY_ODOO_CAPABILITIES, ...(response.capabilities ?? {}) },
        outbox: response.outbox ?? { pending: 0, failed: 0, lastCommAt: null, lastSuccessAt: null },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.debug(`crossmart_connector health check unavailable: ${msg}`);
      return {
        installed: false,
        moduleVersion: null,
        capabilities: { ...EMPTY_ODOO_CAPABILITIES },
        outbox: { pending: 0, failed: 0, lastCommAt: null, lastSuccessAt: null },
        error: msg,
      };
    }
  }

  resolvePartner(
    auth: OdooOperationalAuth,
    input: OdooPartnerResolveInput,
  ): Promise<OdooPartnerResolveResult> {
    return this.request<OdooPartnerResolveResult>(
      auth,
      'POST',
      '/crossmart/api/v1/partners/resolve',
      input,
    );
  }

  upsertOrder(
    auth: OdooOperationalAuth,
    input: OdooOrderUpsertInput,
  ): Promise<OdooOrderOperationResult> {
    return this.request<OdooOrderOperationResult>(
      auth,
      'POST',
      '/crossmart/api/v1/orders/upsert',
      input,
    );
  }

  releaseOrderReservation(
    auth: OdooOperationalAuth,
    externalId: string,
    reason: string,
  ): Promise<OdooOrderOperationResult> {
    return this.request<OdooOrderOperationResult>(
      auth,
      'POST',
      '/crossmart/api/v1/orders/release',
      { externalId, reason },
    );
  }

  cancelOrder(
    auth: OdooOperationalAuth,
    externalId: string,
  ): Promise<OdooOrderOperationResult> {
    return this.request<OdooOrderOperationResult>(
      auth,
      'POST',
      '/crossmart/api/v1/orders/cancel',
      { externalId },
    );
  }

  createInvoice(
    auth: OdooOperationalAuth,
    externalId: string,
    post = false,
  ): Promise<OdooInvoiceResult> {
    return this.request<OdooInvoiceResult>(auth, 'POST', '/crossmart/api/v1/orders/invoice', {
      externalId,
      post,
    });
  }

  private async request<T>(
    auth: OdooOperationalAuth,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const baseUrl = auth.url.trim().replace(/\/+$/, '');
    const rawBody = body === undefined ? '' : JSON.stringify(body);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = signCrossmartOdooPayload(auth.apiSecret, timestamp, rawBody);

    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Crossmart-Connection-Id': auth.connectionId,
        'X-Crossmart-Timestamp': timestamp,
        'X-Crossmart-Signature': signature,
      },
      body: method === 'POST' ? rawBody : undefined,
      signal: AbortSignal.timeout(15_000),
    });

    const text = await response.text();
    let parsed: unknown = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { ok: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}` };
    }
    if (!response.ok && typeof parsed === 'object' && parsed !== null && !('error' in parsed)) {
      return { ok: false, error: `HTTP ${response.status}` } as T;
    }
    return parsed as T;
  }
}
