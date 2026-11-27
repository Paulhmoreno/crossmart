import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import {
  CatalogSourceKind,
  InventoryMovementReason,
  type Prisma,
  PrismaService,
} from '@crossmart/database';
import { Actor } from '../../activity/entities/actor.js';
import { ActivityAction } from '../../activity/enums/activity-action.enum.js';
import { ActivitySubjectType } from '../../activity/enums/activity-subject-type.enum.js';
import { ActivityRecorder } from '../../activity/services/activity-recorder.js';
import { CatalogChangeKind } from '../../events/enums/catalog-change-kind.enum.js';
import { CatalogEventBus } from '../../events/services/catalog-event-bus.js';
import { InventoryLedger } from '../../inventory/repositories/inventory-ledger.js';
import {
  EMPTY_ODOO_CAPABILITIES,
  OdooOperationalClient,
  type OdooModuleHealth,
  signCrossmartOdooPayload,
} from '../client/odoo-operational.client.js';
import { OdooCredentialsVault } from './odoo-credentials.vault.js';

const MAX_SKEW_SECONDS = 300;
const SECRET_BYTE_LENGTH = 32;
const MASK_SUFFIX_LENGTH = 4;
const ONE_DAY_MS = 86_400_000;
const MAX_RECENT_EVENTS = 500;
const MAX_ERROR_LENGTH = 500;
const DEFAULT_LOCAL_API_URL = 'http://localhost:3300';
const ODOO_CONNECTION_NOT_FOUND = 'No Odoo connection is configured for this workspace.';

export type OdooPairingState =
  | 'unpaired'
  | 'pending_odoo'
  | 'outbound_only'
  | 'inbound_only'
  | 'verified'
  | 'revoked';

export interface OdooPairingStatus {
  state: OdooPairingState;
  connectionId: string | null;
  secretConfigured: boolean;
  secretMasked: string | null;
  crossmartApiUrl: string;
  isLocalOnlyUrl: boolean;
  odooIsRemote: boolean;
  inboundVerified: boolean;
  outboundVerified: boolean;
  createdAt: string | null;
  rotatedAt: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
}

export interface OdooPairingGeneratedResult {
  connectionId: string;
  crossmartApiUrl: string;
  apiSecret: string;
  secretMasked: string;
  isLocalOnlyUrl: boolean;
  odooIsRemote: boolean;
  rotated: boolean;
  createdAt: string;
}

export interface OdooPairingTestResult {
  ok: boolean;
  state: OdooPairingState;
  outboundOk: boolean;
  inboundOk: boolean;
  outboundError: string | null;
  moduleVersion: string | null;
  capabilities: OdooModuleHealth['capabilities'];
  outbox: OdooModuleHealth['outbox'];
  isLocalOnlyUrl: boolean;
  odooIsRemote: boolean;
  testedAt: string;
}

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

interface StoredPairingMetadata {
  sealedEventSecret?: string | null;
  eventWebhookSecret?: string | null;
  pairingSecretMasked?: string | null;
  pairingCreatedAt?: string | null;
  pairingRotatedAt?: string | null;
  pairingRevokedAt?: string | null;
  pairingLastInboundAt?: string | null;
  pairingLastOutboundAt?: string | null;
  [key: string]: unknown;
}

function safeCompareHex(actual: string, expected: string): boolean {
  const left = Buffer.from(actual, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function asText(val: unknown, fallback = ''): string {
  return typeof val === 'string' || typeof val === 'number' ? String(val) : fallback;
}

function parseSettings(settings: Prisma.JsonValue | null | undefined): StoredPairingMetadata {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return {};
  return { ...(settings as Record<string, unknown>) } as StoredPairingMetadata;
}

function maskSecret(secret: string): string {
  if (secret.length < MASK_SUFFIX_LENGTH) return '••••••';
  return `••••••${secret.slice(-MASK_SUFFIX_LENGTH)}`;
}

function isLocalUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === 'host.docker.internal' ||
      host.endsWith('.local') ||
      host.endsWith('.trycloudflare.com') ||
      host.endsWith('.ngrok-free.app') ||
      host.endsWith('.ngrok.io')
    );
  } catch {
    return true;
  }
}

function resolveCrossmartApiUrl(): string {
  const envUrl =
    process.env.CROSSMART_PUBLIC_API_URL ||
    process.env.PUBLIC_API_URL ||
    process.env.API_PUBLIC_URL ||
    '';
  const trimmed = envUrl.trim().replace(/\/+$/, '');
  if (trimmed) return trimmed;
  return DEFAULT_LOCAL_API_URL;
}

function computePairingState(params: {
  secretConfigured: boolean;
  revokedAt: string | null;
  inboundVerified: boolean;
  outboundVerified: boolean;
}): OdooPairingState {
  if (!params.secretConfigured) {
    return params.revokedAt ? 'revoked' : 'unpaired';
  }
  if (params.inboundVerified && params.outboundVerified) return 'verified';
  if (params.outboundVerified) return 'outbound_only';
  if (params.inboundVerified) return 'inbound_only';
  return 'pending_odoo';
}

@Injectable()
export class OdooEventIngestionService {
  private readonly logger = new Logger(OdooEventIngestionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: InventoryLedger,
    private readonly events: CatalogEventBus,
    private readonly operationalClient: OdooOperationalClient,
    private readonly vault: OdooCredentialsVault,
    private readonly activity: ActivityRecorder,
  ) {}

  private async resolveStoredSecret(
    workspaceId: string,
    settings: StoredPairingMetadata,
  ): Promise<string | null> {
    if (typeof settings.sealedEventSecret === 'string' && settings.sealedEventSecret.length > 0) {
      const opened = await this.vault.open(workspaceId, settings.sealedEventSecret);
      return opened.apiKey?.trim() || null;
    }
    if (typeof settings.eventWebhookSecret === 'string' && settings.eventWebhookSecret.trim()) {
      return settings.eventWebhookSecret.trim();
    }
    return null;
  }

  async generatePairingCredentials(
    workspaceId: string,
    actor: Actor,
    rotate = false,
  ): Promise<OdooPairingGeneratedResult> {
    const connection = await this.prisma.odooConnection.findUnique({ where: { workspaceId } });
    if (!connection) {
      throw new NotFoundException(ODOO_CONNECTION_NOT_FOUND);
    }

    const secret = randomBytes(SECRET_BYTE_LENGTH).toString('base64url');
    const sealedEventSecret = await this.vault.seal(workspaceId, { apiKey: secret });
    const secretMasked = maskSecret(secret);
    const nowIso = new Date().toISOString();
    const existing = parseSettings(connection.settings);

    const nextSettings: StoredPairingMetadata = {
      ...existing,
      sealedEventSecret,
      eventWebhookSecret: null,
      pairingSecretMasked: secretMasked,
      pairingCreatedAt: existing.pairingCreatedAt ?? nowIso,
      pairingRotatedAt: rotate ? nowIso : existing.pairingRotatedAt ?? null,
      pairingRevokedAt: null,
      pairingLastInboundAt: null,
      pairingLastOutboundAt: null,
    };

    await this.prisma.odooConnection.update({
      where: { id: connection.id },
      data: { settings: nextSettings as unknown as Prisma.InputJsonValue },
    });

    await this.activity.record(workspaceId, actor, {
      action: ActivityAction.OdooCredentialsUpdated,
      subject: {
        type: ActivitySubjectType.OdooConnection,
        id: connection.id,
        label: connection.displayName,
      },
      detail: rotate
        ? 'Odoo crossmart_connector pairing credentials rotated'
        : 'Odoo crossmart_connector pairing credentials generated',
    });

    const crossmartApiUrl = resolveCrossmartApiUrl();
    return {
      connectionId: connection.id,
      crossmartApiUrl,
      apiSecret: secret,
      secretMasked,
      isLocalOnlyUrl: isLocalUrl(crossmartApiUrl),
      odooIsRemote: !isLocalUrl(connection.url),
      rotated: rotate,
      createdAt: nowIso,
    };
  }

  async revokePairingCredentials(workspaceId: string, actor: Actor): Promise<{ ok: true }> {
    const connection = await this.prisma.odooConnection.findUnique({ where: { workspaceId } });
    if (!connection) {
      throw new NotFoundException(ODOO_CONNECTION_NOT_FOUND);
    }

    const existing = parseSettings(connection.settings);
    const nowIso = new Date().toISOString();
    const nextSettings: StoredPairingMetadata = {
      ...existing,
      sealedEventSecret: null,
      eventWebhookSecret: null,
      pairingSecretMasked: null,
      pairingRevokedAt: nowIso,
      pairingLastInboundAt: null,
      pairingLastOutboundAt: null,
    };

    await this.prisma.odooConnection.update({
      where: { id: connection.id },
      data: { settings: nextSettings as unknown as Prisma.InputJsonValue },
    });

    await this.activity.record(workspaceId, actor, {
      action: ActivityAction.OdooCredentialsUpdated,
      subject: {
        type: ActivitySubjectType.OdooConnection,
        id: connection.id,
        label: connection.displayName,
      },
      detail: 'Odoo crossmart_connector pairing credentials revoked',
    });

    return { ok: true };
  }

  async testModulePairing(workspaceId: string): Promise<OdooPairingTestResult> {
    const connection = await this.prisma.odooConnection.findUnique({ where: { workspaceId } });
    if (!connection) {
      throw new NotFoundException(ODOO_CONNECTION_NOT_FOUND);
    }

    const settings = parseSettings(connection.settings);
    const secret = await this.resolveStoredSecret(workspaceId, settings);
    const crossmartApiUrl = resolveCrossmartApiUrl();
    const isLocalOnlyUrl = isLocalUrl(crossmartApiUrl);
    const odooIsRemote = !isLocalUrl(connection.url);
    const nowIso = new Date().toISOString();

    if (!secret) {
      return {
        ok: false,
        state: settings.pairingRevokedAt ? 'revoked' : 'unpaired',
        outboundOk: false,
        inboundOk: false,
        outboundError: 'No pairing credentials configured.',
        moduleVersion: null,
        capabilities: { ...EMPTY_ODOO_CAPABILITIES },
        outbox: { pending: 0, failed: 0, lastCommAt: null, lastSuccessAt: null },
        isLocalOnlyUrl,
        odooIsRemote,
        testedAt: nowIso,
      };
    }

    const health = await this.operationalClient.getHealth({
      url: connection.url,
      connectionId: connection.id,
      apiSecret: secret,
    });

    const outboundOk = health.installed;
    if (outboundOk) {
      const nextSettings: StoredPairingMetadata = {
        ...settings,
        pairingLastOutboundAt: nowIso,
      };
      await this.prisma.odooConnection.update({
        where: { id: connection.id },
        data: { settings: nextSettings as unknown as Prisma.InputJsonValue },
      });
    }

    const effectiveSince = settings.pairingRotatedAt ?? settings.pairingCreatedAt ?? null;
    const inboundOk = Boolean(
      settings.pairingLastInboundAt &&
        (!effectiveSince || settings.pairingLastInboundAt >= effectiveSince),
    );

    const state = computePairingState({
      secretConfigured: true,
      revokedAt: null,
      inboundVerified: inboundOk,
      outboundVerified: outboundOk,
    });

    return {
      ok: outboundOk && inboundOk,
      state,
      outboundOk,
      inboundOk,
      outboundError: outboundOk ? null : (health.error ?? 'Module unreachable or not configured.'),
      moduleVersion: health.moduleVersion,
      capabilities: health.capabilities,
      outbox: health.outbox,
      isLocalOnlyUrl,
      odooIsRemote,
      testedAt: nowIso,
    };
  }

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
    const settings = parseSettings(connection.settings);
    const secret = await this.resolveStoredSecret(connection.workspaceId, settings);
    if (!secret) {
      throw new UnauthorizedException('Odoo module pairing secret is not configured or was revoked.');
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
    const now = new Date();
    const nextSettings: StoredPairingMetadata = {
      ...parseSettings(connection.settings),
      pairingLastInboundAt: now.toISOString(),
    };
    await this.prisma.odooConnection.update({
      where: { id: connection.id },
      data: {
        lastTestedAt: now,
        settings: nextSettings as unknown as Prisma.InputJsonValue,
      },
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
            errorMessage: msg.slice(0, MAX_ERROR_LENGTH),
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

    const now = new Date();
    const nextSettings: StoredPairingMetadata = {
      ...parseSettings(connection.settings),
      pairingLastInboundAt: now.toISOString(),
    };
    await this.prisma.odooConnection.update({
      where: { id: connection.id },
      data: {
        lastSyncedAt: now,
        settings: nextSettings as unknown as Prisma.InputJsonValue,
      },
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
    pairing: OdooPairingStatus;
    module: OdooModuleHealth;
    inboundStats: {
      processedLast24h: number;
      failedLast24h: number;
      avgProcessingMs: number;
      lastEventAt: string | null;
    };
  }> {
    const connection = await this.prisma.odooConnection.findUnique({ where: { workspaceId } });
    const since = new Date(Date.now() - ONE_DAY_MS);
    const recentEvents = connection
      ? await this.prisma.odooInboundEvent.findMany({
          where: { connectionId: connection.id, processedAt: { gte: since } },
          select: { status: true, processingMs: true, processedAt: true },
          orderBy: { processedAt: 'desc' },
          take: MAX_RECENT_EVENTS,
        })
      : [];

    const processedLast24h = recentEvents.filter((e) => e.status === 'PROCESSED').length;
    const failedLast24h = recentEvents.filter((e) => e.status === 'FAILED').length;
    const avgProcessingMs =
      recentEvents.length > 0
        ? Math.round(recentEvents.reduce((acc, e) => acc + e.processingMs, 0) / recentEvents.length)
        : 0;
    const lastEventAt = recentEvents[0]?.processedAt.toISOString() ?? null;

    const settings = parseSettings(connection?.settings);
    const secret = connection ? await this.resolveStoredSecret(workspaceId, settings) : null;
    const crossmartApiUrl = resolveCrossmartApiUrl();
    const isLocalOnlyUrl = isLocalUrl(crossmartApiUrl);
    const odooIsRemote = connection ? !isLocalUrl(connection.url) : false;

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
            capabilities: { ...EMPTY_ODOO_CAPABILITIES },
            outbox: { pending: 0, failed: 0, lastCommAt: null, lastSuccessAt: null },
          };

    const effectiveSince = settings.pairingRotatedAt ?? settings.pairingCreatedAt ?? null;
    const inboundVerified = Boolean(
      secret &&
        settings.pairingLastInboundAt &&
        (!effectiveSince || settings.pairingLastInboundAt >= effectiveSince),
    );
    const outboundVerified = Boolean(secret && module.installed);
    const lastOutboundAt = outboundVerified
      ? new Date().toISOString()
      : (settings.pairingLastOutboundAt ?? null);

    const pairing: OdooPairingStatus = {
      state: computePairingState({
        secretConfigured: Boolean(secret),
        revokedAt: settings.pairingRevokedAt ?? null,
        inboundVerified,
        outboundVerified,
      }),
      connectionId: connection?.id ?? null,
      secretConfigured: Boolean(secret),
      secretMasked: secret ? (settings.pairingSecretMasked ?? maskSecret(secret)) : null,
      crossmartApiUrl,
      isLocalOnlyUrl,
      odooIsRemote,
      inboundVerified,
      outboundVerified,
      createdAt: settings.pairingCreatedAt ?? null,
      rotatedAt: settings.pairingRotatedAt ?? null,
      lastInboundAt: settings.pairingLastInboundAt ?? null,
      lastOutboundAt,
    };

    return {
      pairing,
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
      const variantIdExt = asText(payload.variantId ?? item.entityId);
      const freeQty = Math.max(0, Math.floor(Number(payload.freeQty ?? payload.qtyAvailable ?? 0)));
      const reservedQty = Math.max(0, Math.floor(Number(payload.reservedQty ?? 0)));

      const variant = await this.prisma.variant.findFirst({
        where: {
          workspaceId,
          product: { sourceKind: CatalogSourceKind.ODOO },
          OR: [{ sourceExternalId: variantIdExt }, ...(sku ? [{ sku }] : [])],
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
      const templateIdExt = asText(payload.templateId ?? item.entityId);
      const product = await this.prisma.product.findFirst({
        where: { workspaceId, sourceKind: CatalogSourceKind.ODOO, sourceExternalId: templateIdExt },
        include: { variants: { include: { inventoryItem: true } } },
      });
      if (!product) return { inventoryItemIds, productIds };

      const variantsPayload = Array.isArray(payload.variants)
        ? (payload.variants as Array<Record<string, unknown>>)
        : [];
      for (const vp of variantsPayload) {
        const vExt = asText(vp.variantId);
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
      const extOrderId =
        typeof payload.crossmartExternalId === 'string' ? payload.crossmartExternalId : null;
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
      const extOrderId =
        typeof payload.crossmartExternalId === 'string' ? payload.crossmartExternalId : null;
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
