import { timingSafeEqual } from 'node:crypto';
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import {
  CatalogSourceKind,
  InventoryMovementReason,
  type Prisma,
  PrismaService,
} from '@crossmart/database';
import { Actor } from '../../activity/entities/actor.js';
import { CatalogChangeKind } from '../../events/enums/catalog-change-kind.enum.js';
import { CatalogEventBus } from '../../events/services/catalog-event-bus.js';
import { InventoryLedger } from '../../inventory/repositories/inventory-ledger.js';
import {
  OdooOperationalClient,
  type OdooModuleHealth,
  signCrossmartOdooPayload,
} from '../client/odoo-operational.client.js';

const MAX_SKEW_SECONDS = 300;

export interface OdooOutboxEventItem {
  eventId: string;
  outboxId?: number;
  eventKey?: string;
  entityType: string;
  entityId: number;
  eventType: string;
  version: number;
  companyId?: number;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export interface OdooEventBatchInput {
  connectionId: string;
  moduleVersion?: string;
  sentAt?: string;
  events: OdooOutboxEventItem[];
}

export interface OdooEventBatchResult {
  ok: true;
  received: number;
  processed: number;
  deduplicated: number;
  failed: number;
  totalProcessingMs: number;
}

function safeCompareHex(actual: string, expected: string): boolean {
  const a = Buffer.from(actual, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function asText(val: unknown, fallback = ''): string {
  return typeof val === 'string' || typeof val === 'number' ? String(val) : fallback;
}

function readWebhookSecret(settings: Prisma.JsonValue | null | undefined): string | null {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return null;
  const raw = (settings as Record<string, unknown>).eventWebhookSecret;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
}

@Injectable()
export class OdooEventIngestionService {
  private readonly logger = new Logger(OdooEventIngestionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: InventoryLedger,
    private readonly events: CatalogEventBus,
    private readonly operationalClient: OdooOperationalClient,
  ) {}

  async verifyAndAuthenticate(
    connectionId: string,
    timestamp: string,
    signature: string,
    rawBody: string,
  ): Promise<{ id: string; workspaceId: string; settings: Prisma.JsonValue }> {
    if (!connectionId || !timestamp || !signature) {
      throw new UnauthorizedException('Missing Crossmart-Odoo authentication headers.');
    }
    const ts = Number.parseInt(timestamp, 10);
    if (!Number.isFinite(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > MAX_SKEW_SECONDS) {
      throw new UnauthorizedException('Expired or invalid Odoo event timestamp.');
    }
    const connection = await this.prisma.odooConnection.findUnique({
      where: { id: connectionId },
      select: { id: true, workspaceId: true, settings: true },
    });
    if (!connection) {
      throw new UnauthorizedException('Unknown Odoo connection.');
    }
    const secret = readWebhookSecret(connection.settings);
    if (!secret) {
      throw new UnauthorizedException('Odoo event webhook secret is not configured.');
    }
    const expected = signCrossmartOdooPayload(secret, timestamp, rawBody);
    if (!safeCompareHex(signature, expected)) {
      throw new UnauthorizedException('Invalid Odoo event signature.');
    }
    return connection;
  }

  async handlePing(
    connectionId: string,
    timestamp: string,
    signature: string,
    rawBody: string,
  ): Promise<{ ok: true; connectionId: string }> {
    const connection = await this.verifyAndAuthenticate(connectionId, timestamp, signature, rawBody);
    await this.prisma.odooConnection.update({
      where: { id: connection.id },
      data: { lastTestedAt: new Date() },
    });
    return { ok: true, connectionId: connection.id };
  }

  async ingestBatch(
    connectionId: string,
    timestamp: string,
    signature: string,
    rawBody: string,
    batch: OdooEventBatchInput,
  ): Promise<OdooEventBatchResult> {
    const started = Date.now();
    const connection = await this.verifyAndAuthenticate(connectionId, timestamp, signature, rawBody);
    const events = Array.isArray(batch.events) ? batch.events : [];

    let processed = 0;
    let deduplicated = 0;
    let failed = 0;
    const changedInventoryIds: string[] = [];
    const changedProductIds: string[] = [];

    for (const item of events) {
      const evStart = Date.now();
      const existing = await this.prisma.odooInboundEvent.findUnique({
        where: {
          connectionId_externalEventId: {
            connectionId: connection.id,
            externalEventId: item.eventId,
          },
        },
        select: { id: true },
      });
      if (existing) {
        deduplicated += 1;
        continue;
      }

      try {
        const outcome = await this.applyEvent(connection.workspaceId, item);
        changedInventoryIds.push(...outcome.inventoryItemIds);
        changedProductIds.push(...outcome.productIds);

        await this.prisma.odooInboundEvent.create({
          data: {
            workspaceId: connection.workspaceId,
            connectionId: connection.id,
            externalEventId: item.eventId,
            entityType: item.entityType,
            entityId: item.entityId,
            eventType: item.eventType,
            version: item.version ?? 1,
            status: 'PROCESSED',
            processingMs: Date.now() - evStart,
            occurredAt: item.occurredAt ? new Date(item.occurredAt) : new Date(),
          },
        });
        processed += 1;
      } catch (error) {
        failed += 1;
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Failed to process Odoo event ${item.eventId}: ${msg}`);
        await this.prisma.odooInboundEvent.create({
          data: {
            workspaceId: connection.workspaceId,
            connectionId: connection.id,
            externalEventId: item.eventId,
            entityType: item.entityType,
            entityId: item.entityId,
            eventType: item.eventType,
            version: item.version ?? 1,
            status: 'FAILED',
            processingMs: Date.now() - evStart,
            errorMessage: msg.slice(0, 500),
            occurredAt: item.occurredAt ? new Date(item.occurredAt) : new Date(),
          },
        });
      }
    }

    if (changedInventoryIds.length > 0) {
      await this.events.stockChanged({
        workspaceId: connection.workspaceId,
        inventoryItemIds: [...new Set(changedInventoryIds)],
      });
    }
    if (changedProductIds.length > 0) {
      await this.events.productsChanged({
        workspaceId: connection.workspaceId,
        productIds: [...new Set(changedProductIds)],
        kinds: [CatalogChangeKind.Price, CatalogChangeKind.Stock],
      });
    }

    await this.prisma.odooConnection.update({
      where: { id: connection.id },
      data: { lastSyncedAt: new Date() },
    });

    return {
      ok: true,
      received: events.length,
      processed,
      deduplicated,
      failed,
      totalProcessingMs: Date.now() - started,
    };
  }

  async getOperationalCapabilities(workspaceId: string): Promise<{
    module: OdooModuleHealth;
    inboundStats: {
      processedLast24h: number;
      failedLast24h: number;
      avgProcessingMs: number;
      lastEventAt: string | null;
    };
  }> {
    const connection = await this.prisma.odooConnection.findUnique({ where: { workspaceId } });
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentEvents = connection
      ? await this.prisma.odooInboundEvent.findMany({
          where: { connectionId: connection.id, processedAt: { gte: since } },
          select: { status: true, processingMs: true, processedAt: true },
          orderBy: { processedAt: 'desc' },
          take: 500,
        })
      : [];

    const processedLast24h = recentEvents.filter((e) => e.status === 'PROCESSED').length;
    const failedLast24h = recentEvents.filter((e) => e.status === 'FAILED').length;
    const avgProcessingMs =
      recentEvents.length > 0
        ? Math.round(recentEvents.reduce((acc, e) => acc + e.processingMs, 0) / recentEvents.length)
        : 0;
    const lastEventAt = recentEvents[0]?.processedAt.toISOString() ?? null;

    const secret = readWebhookSecret(connection?.settings);
    const module: OdooModuleHealth =
      connection && secret
        ? await this.operationalClient.getHealth({
            url: connection.url,
            connectionId: connection.id,
            apiSecret: secret,
          })
        : {
            installed: false,
            moduleVersion: null,
            capabilities: {
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
            },
            outbox: { pending: 0, failed: 0, lastCommAt: null, lastSuccessAt: null },
          };

    return {
      module,
      inboundStats: { processedLast24h, failedLast24h, avgProcessingMs, lastEventAt },
    };
  }

  private async applyEvent(
    workspaceId: string,
    item: OdooOutboxEventItem,
  ): Promise<{ inventoryItemIds: string[]; productIds: string[] }> {
    const inventoryItemIds: string[] = [];
    const productIds: string[] = [];
    const payload = item.payload ?? {};

    if (item.entityType === 'stock') {
      const sku = typeof payload.sku === 'string' ? payload.sku : null;
      const variantIdExt = String(payload.variantId ?? item.entityId);
      const freeQty = Math.max(0, Math.floor(Number(payload.freeQty ?? payload.qtyAvailable ?? 0)));
      const reservedQty = Math.max(0, Math.floor(Number(payload.reservedQty ?? 0)));

      const variant = await this.prisma.variant.findFirst({
        where: {
          workspaceId,
          product: { sourceKind: CatalogSourceKind.ODOO },
          OR: [
            { sourceExternalId: variantIdExt },
            ...(sku ? [{ sku }] : []),
          ],
        },
        select: { id: true, productId: true, inventoryItem: { select: { id: true } } },
      });
      if (variant?.inventoryItem) {
        await this.prisma.$transaction(async (tx) => {
          const locked = await this.ledger.lockVariants(tx, workspaceId, [variant.id]);
          const stock = locked.get(variant.id);
          if (!stock) return;
          const availableDelta = freeQty - stock.available;
          const reservedDelta = reservedQty - stock.reserved;
          if (availableDelta !== 0 || reservedDelta !== 0) {
            await this.ledger.applyMovement(tx, workspaceId, {
              stock,
              availableDelta,
              reservedDelta,
              entry: {
                reason: InventoryMovementReason.CORRECTION,
                actor: Actor.system(),
                note: `Odoo event ${item.eventId}`,
              },
            });
            inventoryItemIds.push(stock.id);
          }
        });
      }
      return { inventoryItemIds, productIds };
    }

    if (item.entityType === 'product') {
      const templateIdExt = String(payload.templateId ?? item.entityId);
      const product = await this.prisma.product.findFirst({
        where: { workspaceId, sourceKind: CatalogSourceKind.ODOO, sourceExternalId: templateIdExt },
        include: { variants: { include: { inventoryItem: true } } },
      });
      if (!product) return { inventoryItemIds, productIds };

      const variantsPayload = Array.isArray(payload.variants)
        ? (payload.variants as Array<Record<string, unknown>>)
        : [];
      for (const vp of variantsPayload) {
        const vExt = String(vp.variantId ?? '');
        const match = product.variants.find(
          (v) => v.sourceExternalId === vExt || (vp.sku && v.sku === vp.sku),
        );
        if (!match) continue;
        const nextPrice = Number(vp.listPrice ?? payload.listPrice ?? match.price);
        const nextCost = Number(vp.standardPrice ?? payload.standardPrice ?? match.cost ?? 0);
        await this.prisma.variant.update({
          where: { id: match.id },
          data: {
            price: Number.isFinite(nextPrice) ? nextPrice.toFixed(2) : match.price,
            cost: Number.isFinite(nextCost) ? nextCost.toFixed(2) : match.cost,
          },
        });
        productIds.push(product.id);
      }
      return { inventoryItemIds, productIds };
    }

    if (item.entityType === 'sale_order') {
      const extOrderId = typeof payload.crossmartExternalId === 'string' ? payload.crossmartExternalId : null;
      if (!extOrderId) return { inventoryItemIds, productIds };
      const order = await this.prisma.order.findFirst({
        where: { workspaceId, externalId: extOrderId },
        select: { id: true },
      });
      if (!order) return { inventoryItemIds, productIds };

      const resStatus = asText(payload.reservationStatus);
      const mappedRes =
        resStatus === 'reserved'
          ? 'RESERVED'
          : resStatus === 'partial'
            ? 'PARTIALLY_RESERVED'
            : resStatus === 'fulfilled'
              ? 'FULFILLED'
              : payload.state === 'cancel'
                ? 'RELEASED'
                : 'UNRESERVED';

      await this.prisma.order.update({
        where: { id: order.id },
        data: {
          erpOrderId: payload.orderId ? asText(payload.orderId) : undefined,
          erpOrderName: typeof payload.orderName === 'string' ? payload.orderName : undefined,
          reservationStatus: mappedRes,
          commercialStatus: payload.state === 'cancel' ? 'CANCELLED' : undefined,
          manualInterventionRequired: Boolean(payload.manualOverride),
        },
      });
      await this.prisma.orderEvent.create({
        data: {
          workspaceId,
          orderId: order.id,
          eventType: 'ODOO_ORDER_UPDATED',
          summary: `Actualización desde Odoo (${asText(payload.orderName)}): estado ${asText(payload.state)}, reserva ${mappedRes}`,
          actorLabel: 'Odoo ERP',
          metadata: payload as unknown as Prisma.InputJsonValue,
        },
      });
      return { inventoryItemIds, productIds };
    }

    if (item.entityType === 'invoice') {
      const extOrderId = typeof payload.crossmartExternalId === 'string' ? payload.crossmartExternalId : null;
      if (!extOrderId) return { inventoryItemIds, productIds };
      const order = await this.prisma.order.findFirst({
        where: { workspaceId, externalId: extOrderId },
        select: { id: true },
      });
      if (!order) return { inventoryItemIds, productIds };

      const invState = asText(payload.state, 'draft');
      const invoicingStatus =
        invState === 'posted' ? 'POSTED' : invState === 'cancel' ? 'CANCELLED' : 'DRAFT';
      await this.prisma.order.update({
        where: { id: order.id },
        data: {
          erpInvoiceId: payload.invoiceId ? asText(payload.invoiceId) : undefined,
          erpInvoiceName: typeof payload.invoiceName === 'string' ? payload.invoiceName : undefined,
          invoicingStatus,
        },
      });
      await this.prisma.orderEvent.create({
        data: {
          workspaceId,
          orderId: order.id,
          eventType: 'ODOO_INVOICE_UPDATED',
          summary: `Factura Odoo ${asText(payload.invoiceName)}: ${invoicingStatus}`,
          actorLabel: 'Odoo ERP',
          metadata: payload as unknown as Prisma.InputJsonValue,
        },
      });
    }

    return { inventoryItemIds, productIds };
  }
}
