import { toAmount } from '../../catalog/mappers/decimal-amount.mapper.js';
import type { OrderDetail, OrderSummary } from '../entities/order-views.js';
import type { OrderDetailRecord, OrderSummaryRecord } from '../repositories/order.queries.js';

function asJsonObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asJsonArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value as Array<Record<string, unknown>>;
}

export function toOrderSummary(record: OrderSummaryRecord): OrderSummary {
  const incidents = asJsonArray(record.incidents);
  return {
    id: record.id,
    name: record.name,
    status: record.status,
    commercialStatus: record.commercialStatus,
    paymentStatus: record.paymentStatus,
    reservationStatus: record.reservationStatus,
    logisticsStatus: record.logisticsStatus,
    invoicingStatus: record.invoicingStatus,
    financialStatus: record.financialStatus,
    manualInterventionRequired: record.manualInterventionRequired,
    manualReleaseLock: record.manualReleaseLock,
    erpOrderId: record.erpOrderId,
    erpOrderName: record.erpOrderName,
    erpInvoiceId: record.erpInvoiceId,
    erpInvoiceName: record.erpInvoiceName,
    incidentCount: incidents.length,
    currencyCode: record.currencyCode,
    total: toAmount(record.total),
    placedAt: record.placedAt,
    connectionId: record.connectionId,
    storeName: record.connection.displayName,
    channel: record.connection.channel,
    itemCount: record.lines.reduce((sum, line) => sum + line.quantity, 0),
    unmatchedLines: record.lines.filter((line) => line.quantity > 0 && !line.variantId).length,
  };
}

export function toOrderDetail(record: OrderDetailRecord): OrderDetail {
  return {
    ...toOrderSummary(record),
    externalId: record.externalId,
    externalPackId: record.externalPackId,
    manualReleaseReason: record.manualReleaseReason,
    manualReleasedAt: record.manualReleasedAt,
    buyerInfo: asJsonObject(record.buyerInfo),
    fiscalInfo: asJsonObject(record.fiscalInfo),
    shippingInfo: asJsonObject(record.shippingInfo),
    financialBreakdown: asJsonObject(record.financialBreakdown),
    logisticsInfo: asJsonObject(record.logisticsInfo),
    incidents: asJsonArray(record.incidents),
    events: record.events.map((ev) => ({
      id: ev.id,
      eventType: ev.eventType,
      summary: ev.summary,
      actorLabel: ev.actorLabel,
      metadata: asJsonObject(ev.metadata) ?? {},
      createdAt: ev.createdAt,
    })),
    lines: record.lines
      .filter((line) => line.quantity > 0 || line.fulfilledQuantity > 0)
      .map((line) => ({
        id: line.id,
        title: line.title,
        sku: line.sku,
        quantity: line.quantity,
        unitPrice: toAmount(line.unitPrice),
        reservedQuantity: line.reservedQuantity,
        fulfilledQuantity: line.fulfilledQuantity,
        variantId: line.variantId,
        productId: line.variant?.productId ?? null,
      })),
  };
}
