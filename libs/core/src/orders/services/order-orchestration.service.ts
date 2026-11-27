import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  InventoryMovementReason,
  type Prisma,
  PrismaService,
} from '@crossmart/database';
import type { Actor } from '../../activity/entities/actor.js';
import { CatalogEventBus } from '../../events/services/catalog-event-bus.js';
import { InventoryLedger } from '../../inventory/repositories/inventory-ledger.js';
import {
  OdooOperationalClient,
  type OdooOperationalAuth,
} from '../../odoo/client/odoo-operational.client.js';
import { OdooCredentialsVault } from '../../odoo/services/odoo-credentials.vault.js';
import { ORDER_NOT_FOUND } from '../orders.constants.js';

export type StoreInvoicingPolicy =
  | 'MANUAL'
  | 'DRAFT_ON_ORDER'
  | 'ON_LABEL_PRINT'
  | 'ON_LOGISTICS_EVENT'
  | 'SCHEDULED';

export interface StoreOrderPolicy {
  importOrders: boolean;
  createErpOrder: boolean;
  reserveInventory: boolean;
  autoCancelRelease: boolean;
  warehouseId?: number | null;
  invoicingPolicy: StoreInvoicingPolicy;
  autoInvoicingEnabled: boolean;
  scheduledInvoicingTime?: string | null; // HH:mm in America/Guayaquil
  invoicingTimezone: string;
  importFinancials: boolean;
}

export const DEFAULT_STORE_ORDER_POLICY: StoreOrderPolicy = {
  importOrders: false,
  createErpOrder: false,
  reserveInventory: true,
  autoCancelRelease: true,
  warehouseId: null,
  invoicingPolicy: 'MANUAL',
  autoInvoicingEnabled: false,
  scheduledInvoicingTime: null,
  invoicingTimezone: 'America/Guayaquil',
  importFinancials: true,
};

export interface OrderFinancialBreakdown {
  currencyCode: string;
  dataStatus: 'UNAVAILABLE' | 'ESTIMATED' | 'CONFIRMED';
  grossSale: number | null;
  taxes: number | null;
  discounts: Array<{
    label: string;
    amount: number;
    responsible: 'SELLER' | 'MARKETPLACE' | 'UNKNOWN';
  }>;
  marketplaceCommission: number | null;
  additionalFees: number | null;
  shippingCost: number | null;
  refunds: number | null;
  withholdings: number | null;
  expectedSettlement: number | null;
  effectiveSettlement: number | null;
  discrepancy: number | null;
  supportingDocuments: string[];
  reconciledAt: string | null;
  reconciliationStatus: 'UNAVAILABLE' | 'PENDING' | 'RECONCILED' | 'DISCREPANCY';
  unavailableReasons: string[];
}

export interface OrderIncident {
  code: string;
  severity: 'warning' | 'error';
  message: string;
  createdAt: string;
  resolved?: boolean;
}

export interface ManualReleaseInput {
  reason: string;
  cancelErpOrder?: boolean;
}

export interface ManualInvoiceInput {
  post?: boolean;
}

function parseJsonObject(raw: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}

function parseIncidents(raw: Prisma.JsonValue | null | undefined): OrderIncident[] {
  if (!Array.isArray(raw)) return [];
  return raw as unknown as OrderIncident[];
}

export function extractStoreOrderPolicy(settings: Prisma.JsonValue | null | undefined): StoreOrderPolicy {
  const root = parseJsonObject(settings);
  const raw = parseJsonObject(root.orderPolicy as Prisma.JsonValue | undefined);
  return {
    importOrders: typeof raw.importOrders === 'boolean' ? raw.importOrders : Boolean(root.importOrders),
    createErpOrder: Boolean(raw.createErpOrder),
    reserveInventory: typeof raw.reserveInventory === 'boolean' ? raw.reserveInventory : true,
    autoCancelRelease: typeof raw.autoCancelRelease === 'boolean' ? raw.autoCancelRelease : true,
    warehouseId: typeof raw.warehouseId === 'number' ? raw.warehouseId : null,
    invoicingPolicy:
      raw.invoicingPolicy === 'DRAFT_ON_ORDER' ||
      raw.invoicingPolicy === 'ON_LABEL_PRINT' ||
      raw.invoicingPolicy === 'ON_LOGISTICS_EVENT' ||
      raw.invoicingPolicy === 'SCHEDULED'
        ? raw.invoicingPolicy
        : 'MANUAL',
    autoInvoicingEnabled: Boolean(raw.autoInvoicingEnabled),
    scheduledInvoicingTime:
      typeof raw.scheduledInvoicingTime === 'string' ? raw.scheduledInvoicingTime : null,
    invoicingTimezone:
      typeof raw.invoicingTimezone === 'string' ? raw.invoicingTimezone : 'America/Guayaquil',
    importFinancials: typeof raw.importFinancials === 'boolean' ? raw.importFinancials : true,
  };
}

/**
 * Deterministic universal order orchestration service.
 * Works natively with Crossmart's InventoryLedger when no ERP is configured, and delegates
 * authorized operational steps to Odoo's `crossmart_connector` when configured and permitted.
 * Never uses LLMs for transactional stock, reservation, cancellation, or billing decisions.
 */
@Injectable()
export class OrderOrchestrationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: InventoryLedger,
    private readonly events: CatalogEventBus,
    private readonly odooClient: OdooOperationalClient,
    private readonly odooVault?: OdooCredentialsVault,
  ) {}

  private async resolveOdooOperationalAuth(workspaceId: string): Promise<OdooOperationalAuth | null> {
    const conn = await this.prisma.odooConnection.findUnique({
      where: { workspaceId },
      select: { id: true, url: true, settings: true },
    });
    if (!conn) return null;
    const settings = parseJsonObject(conn.settings);
    let secret = '';
    if (typeof settings.sealedEventSecret === 'string' && settings.sealedEventSecret && this.odooVault) {
      const opened = await this.odooVault.open(workspaceId, settings.sealedEventSecret);
      secret = opened.apiKey?.trim() ?? '';
    } else if (typeof settings.eventWebhookSecret === 'string') {
      secret = settings.eventWebhookSecret.trim();
    }
    if (!secret) return null;
    return { url: conn.url, connectionId: conn.id, apiSecret: secret };
  }

  /**
   * Emergency manual release of reserved stock.
   * Requires mandatory reason, records actor & timestamp, locks against automatic re-reservation,
   * and distinguishes releasing stock from cancelling the sale order or marketplace order.
   */
  async releaseReservation(
    workspaceId: string,
    orderId: string,
    input: ManualReleaseInput,
    actor: Actor,
  ) {
    const reason = input.reason?.trim();
    if (!reason || reason.length < 3) {
      throw new BadRequestException('A clear reason is required to release reserved stock.');
    }

    const order = await this.prisma.order.findFirst({
      where: { id: orderId, workspaceId },
      include: { lines: true, connection: true },
    });
    if (!order) throw new NotFoundException(ORDER_NOT_FOUND);
    if (order.logisticsStatus === 'DELIVERED' || order.status === 'FULFILLED') {
      throw new ConflictException('Cannot release reservation for an already fulfilled order.');
    }

    const odooAuth = await this.resolveOdooOperationalAuth(workspaceId);
    const changedInventoryIds: string[] = [];

    if (odooAuth && order.erpOrderId) {
      const health = await this.odooClient.getHealth(odooAuth);
      if (!health.installed || !health.capabilities.releaseStock) {
        throw new ForbiddenException(
          'Odoo has not authorized stock reservation release (crossmart_connector).',
        );
      }
      const res = await this.odooClient.releaseOrderReservation(odooAuth, order.externalId, reason);
      if (!res.ok) {
        throw new ConflictException(`Odoo refused reservation release: ${res.error ?? 'unknown'}`);
      }
    } else {
      // Native Crossmart reservation release via row-locked InventoryLedger
      await this.prisma.$transaction(async (tx) => {
        const variantIds = order.lines
          .filter((l) => l.variantId && l.reservedQuantity > 0)
          .map((l) => l.variantId as string);
        if (variantIds.length > 0) {
          const locked = await this.ledger.lockVariants(tx, workspaceId, variantIds);
          const movements = [];
          for (const line of order.lines) {
            if (!line.variantId || line.reservedQuantity <= 0) continue;
            const stock = locked.get(line.variantId);
            if (!stock) continue;
            const releaseQty = Math.min(stock.reserved, line.reservedQuantity);
            if (releaseQty > 0) {
              movements.push({
                stock,
                reservedDelta: -releaseQty,
                availableDelta: releaseQty,
                entry: {
                  reason: InventoryMovementReason.CORRECTION,
                  actor,
                  note: `Manual release ${order.name}: ${reason}`,
                },
              });
            }
            await tx.orderLine.update({
              where: { id: line.id },
              data: { reservedQuantity: 0 },
            });
          }
          if (movements.length > 0) {
            const after = await this.ledger.applyMovements(tx, workspaceId, movements);
            changedInventoryIds.push(...after.map((i) => i.inventoryItemId));
          }
        }
      });
    }

    const now = new Date();
    const incidents = parseIncidents(order.incidents);
    incidents.push({
      code: 'MANUAL_RESERVATION_RELEASED',
      severity: 'warning',
      message: `Reserva liberada manualmente: ${reason}`,
      createdAt: now.toISOString(),
    });

    await this.prisma.order.update({
      where: { id: order.id },
      data: {
        reservationStatus: 'MANUALLY_RELEASED',
        manualInterventionRequired: true,
        manualReleaseLock: true,
        manualReleaseReason: reason,
        manualReleasedAt: now,
        manualReleasedById: actor.userId ?? null,
        incidents: incidents as unknown as Prisma.InputJsonValue,
      },
    });

    await this.prisma.orderEvent.create({
      data: {
        workspaceId,
        orderId: order.id,
        eventType: 'MANUAL_RESERVATION_RELEASED',
        summary: `Reserva liberada manualmente (${reason}). Bloqueada re-reserva automática.`,
        actorLabel: actor.userId ?? 'Operador autorizado',
        metadata: {
          reason,
          erpOrderName: order.erpOrderName,
          cancelErpOrderRequested: Boolean(input.cancelErpOrder),
        },
      },
    });

    if (changedInventoryIds.length > 0) {
      await this.events.stockChanged({ workspaceId, inventoryItemIds: changedInventoryIds });
    }

    return {
      ok: true,
      orderId: order.id,
      reservationStatus: 'MANUALLY_RELEASED',
      manualReleaseLock: true,
      manualInterventionRequired: true,
    };
  }

  /**
   * Explicitly authorized re-reservation after a manual release or stock replenishment.
   */
  async reReserveOrder(workspaceId: string, orderId: string, actor: Actor) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, workspaceId },
      include: { lines: true, connection: true },
    });
    if (!order) throw new NotFoundException(ORDER_NOT_FOUND);
    if (order.status === 'CANCELLED' || order.commercialStatus === 'CANCELLED') {
      throw new ConflictException('Cannot reserve inventory for a cancelled order.');
    }

    const odooAuth = await this.resolveOdooOperationalAuth(workspaceId);
    let nextStatus = 'RESERVED';
    const changedInventoryIds: string[] = [];

    if (odooAuth && order.erpOrderId) {
      const health = await this.odooClient.getHealth(odooAuth);
      if (!health.installed || !health.capabilities.reserveStock) {
        throw new ForbiddenException('Odoo has not authorized stock reservation.');
      }
      const res = await this.odooClient.upsertOrder(odooAuth, {
        externalId: order.externalId,
        orderRef: order.name,
        channel: order.connection.channel,
        storeName: order.connection.displayName,
        partnerId: 1,
        reserveStock: true,
        lines: order.lines.map((l) => ({
          sku: l.sku,
          quantity: l.quantity,
          unitPrice: Number(l.unitPrice),
        })),
      });
      nextStatus =
        res.reservationStatus === 'reserved'
          ? 'RESERVED'
          : res.reservationStatus === 'partial'
            ? 'PARTIALLY_RESERVED'
            : 'INSUFFICIENT_STOCK';
    } else {
      await this.prisma.$transaction(async (tx) => {
        const variantIds = order.lines
          .filter((l) => l.variantId && l.quantity > l.fulfilledQuantity)
          .map((l) => l.variantId as string);
        const locked = await this.ledger.lockVariants(tx, workspaceId, variantIds);
        const movements = [];
        let totalNeeded = 0;
        let totalReserved = 0;

        for (const line of order.lines) {
          const needed = Math.max(0, line.quantity - line.fulfilledQuantity - line.reservedQuantity);
          totalNeeded += needed;
          if (!line.variantId || needed <= 0) continue;
          const stock = locked.get(line.variantId);
          if (!stock || !stock.tracked) continue;
          const canReserve = Math.max(0, Math.min(stock.available, needed));
          totalReserved += canReserve;
          if (canReserve > 0) {
            movements.push({
              stock,
              availableDelta: -canReserve,
              reservedDelta: canReserve,
              entry: {
                reason: InventoryMovementReason.CORRECTION,
                actor,
                note: `Authorized re-reserve ${order.name}`,
              },
            });
            await tx.orderLine.update({
              where: { id: line.id },
              data: { reservedQuantity: line.reservedQuantity + canReserve },
            });
          }
        }
        if (movements.length > 0) {
          const after = await this.ledger.applyMovements(tx, workspaceId, movements);
          changedInventoryIds.push(...after.map((i) => i.inventoryItemId));
        }
        if (totalNeeded > 0) {
          nextStatus =
            totalReserved >= totalNeeded
              ? 'RESERVED'
              : totalReserved > 0
                ? 'PARTIALLY_RESERVED'
                : 'INSUFFICIENT_STOCK';
        }
      });
    }

    await this.prisma.order.update({
      where: { id: order.id },
      data: {
        reservationStatus: nextStatus,
        manualReleaseLock: false,
        manualInterventionRequired: nextStatus !== 'RESERVED',
      },
    });

    await this.prisma.orderEvent.create({
      data: {
        workspaceId,
        orderId: order.id,
        eventType: 'RESERVATION_RESTORED',
        summary: `Nueva reserva autorizada ejecutada: estado ${nextStatus}.`,
        actorLabel: actor.userId ?? 'Operador autorizado',
        metadata: { reservationStatus: nextStatus },
      },
    });

    if (changedInventoryIds.length > 0) {
      await this.events.stockChanged({ workspaceId, inventoryItemIds: changedInventoryIds });
    }

    return { ok: true, orderId: order.id, reservationStatus: nextStatus };
  }

  /**
   * Generates a draft invoice in Odoo when explicitly authorized.
   * Re-verifies order is not cancelled, checks fiscal data, prevents duplicates,
   * and never posts/emits electronically unless explicitly allowed by both Crossmart and Odoo.
   */
  async generateInvoice(
    workspaceId: string,
    orderId: string,
    input: ManualInvoiceInput,
    actor: Actor,
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, workspaceId },
      include: { connection: true },
    });
    if (!order) throw new NotFoundException(ORDER_NOT_FOUND);
    if (order.status === 'CANCELLED' || order.commercialStatus === 'CANCELLED') {
      throw new ConflictException('Cannot invoice a cancelled order.');
    }
    if (order.erpInvoiceId && order.invoicingStatus !== 'CANCELLED') {
      return {
        ok: true,
        created: false,
        invoiceId: order.erpInvoiceId,
        invoiceName: order.erpInvoiceName,
        invoicingStatus: order.invoicingStatus,
      };
    }

    const fiscal = parseJsonObject(order.fiscalInfo);
    if (!fiscal.taxId && !fiscal.legalName) {
      const incidents = parseIncidents(order.incidents);
      incidents.push({
        code: 'MISSING_FISCAL_DATA',
        severity: 'warning',
        message: 'Faltan datos fiscales verificados del comprador para emitir factura.',
        createdAt: new Date().toISOString(),
      });
      await this.prisma.order.update({
        where: { id: order.id },
        data: {
          invoicingStatus: 'PENDING_FISCAL_DATA',
          manualInterventionRequired: true,
          incidents: incidents as unknown as Prisma.InputJsonValue,
        },
      });
      throw new BadRequestException(
        'Verified buyer fiscal data is required before generating an invoice.',
      );
    }

    const odooAuth = await this.resolveOdooOperationalAuth(workspaceId);
    if (!odooAuth) {
      throw new BadRequestException(
        'Odoo operational connector (crossmart_connector) is not configured for invoicing.',
      );
    }
    const health = await this.odooClient.getHealth(odooAuth);
    if (!health.installed || !health.capabilities.draftInvoice) {
      throw new ForbiddenException('Odoo has not enabled draft invoice creation.');
    }
    const post = Boolean(input.post);
    if (post && !health.capabilities.postInvoice) {
      throw new ForbiddenException('Odoo has not enabled invoice posting / electronic emission.');
    }

    const inv = await this.odooClient.createInvoice(odooAuth, order.externalId, post);
    if (!inv.ok) {
      throw new ConflictException(`Odoo invoice generation failed: ${inv.error ?? 'unknown'}`);
    }

    const nextInvoicingStatus = inv.state === 'posted' ? 'POSTED' : 'DRAFT';
    await this.prisma.order.update({
      where: { id: order.id },
      data: {
        erpInvoiceId: inv.invoiceId ? String(inv.invoiceId) : null,
        erpInvoiceName: inv.invoiceName ?? null,
        invoicingStatus: nextInvoicingStatus,
      },
    });
    await this.prisma.orderEvent.create({
      data: {
        workspaceId,
        orderId: order.id,
        eventType: 'INVOICE_GENERATED',
        summary: `Factura ${inv.invoiceName ?? ''} generada en Odoo (${nextInvoicingStatus}).`,
        actorLabel: actor.userId ?? 'Operador autorizado',
        metadata: { invoiceId: inv.invoiceId, invoiceName: inv.invoiceName, state: inv.state },
      },
    });

    return {
      ok: true,
      created: Boolean(inv.created),
      invoiceId: inv.invoiceId ?? null,
      invoiceName: inv.invoiceName ?? null,
      invoicingStatus: nextInvoicingStatus,
    };
  }

  /** Read-only operational summary for Crossmart Agent (zero writes). */
  async getOperationalSummary(workspaceId: string) {
    const [total, reserved, partial, insufficient, manualRelease, pendingInvoice, withIncidents] =
      await Promise.all([
        this.prisma.order.count({ where: { workspaceId } }),
        this.prisma.order.count({ where: { workspaceId, reservationStatus: 'RESERVED' } }),
        this.prisma.order.count({ where: { workspaceId, reservationStatus: 'PARTIALLY_RESERVED' } }),
        this.prisma.order.count({ where: { workspaceId, reservationStatus: 'INSUFFICIENT_STOCK' } }),
        this.prisma.order.count({ where: { workspaceId, manualReleaseLock: true } }),
        this.prisma.order.count({ where: { workspaceId, invoicingStatus: 'PENDING_FISCAL_DATA' } }),
        this.prisma.order.count({ where: { workspaceId, manualInterventionRequired: true } }),
      ]);

    return {
      totalOrders: total,
      reservedOrders: reserved,
      partiallyReservedOrders: partial,
      insufficientStockOrders: insufficient,
      manuallyReleasedOrders: manualRelease,
      pendingFiscalDataOrders: pendingInvoice,
      ordersRequiringAttention: withIncidents,
    };
  }
}
