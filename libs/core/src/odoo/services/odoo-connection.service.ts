import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { describeError } from '@crossmart/common';
import {
  CatalogSourceKind,
  type OdooConnection,
  OdooConnectionStatus,
  type OdooSyncRun,
  type Prisma,
  PrismaService,
} from '@crossmart/database';
import type { Actor } from '../../activity/entities/actor.js';
import { ActivityAction } from '../../activity/enums/activity-action.enum.js';
import { ActivitySubjectType } from '../../activity/enums/activity-subject-type.enum.js';
import { ActivityRecorder } from '../../activity/services/activity-recorder.js';
import { OdooReadOnlyClient } from '../client/odoo-readonly.client.js';
import type {
  OdooAdvancedSettings,
  OdooConnectionView,
  OdooCredentialsInput,
  OdooDiscoveredCapabilities,
  OdooPreviewProduct,
  OdooStoredSettings,
  OdooSyncIssue,
  OdooSyncRunView,
  OdooTestConnectionResult,
} from '../entities/odoo-connection.js';
import { ODOO_DEFAULT_PREVIEW_LIMIT, ODOO_MAX_PREVIEW_LIMIT } from '../odoo.constants.js';
import { buildOdooSourceOrigin } from '../rules/odoo-document-classifier.js';
import { OdooCredentialsVault } from './odoo-credentials.vault.js';

const CONNECTION_NOT_FOUND = 'No Odoo connection is configured for this workspace.';
const CREDENTIALS_REQUIRED = 'Enter an Odoo API key to connect.';
const DOCUMENT_NOT_FOUND = 'Document not found.';
const INSTANCE_CHANGE_BLOCKED =
  'No se puede cambiar la URL o base de datos de Odoo mientras existan productos sincronizados de otra instancia, para evitar mezclar identidades de catálogo.';
const RECENT_RUNS_LIMIT = 10;

export interface UpsertOdooConnectionInput {
  url: string;
  database: string;
  username: string;
  apiKey?: string;
  displayName?: string;
  settings?: OdooAdvancedSettings;
}

export interface TestOdooConnectionInput {
  url?: string;
  database?: string;
  username?: string;
  apiKey?: string;
}

function parseStoredSettings(raw: Prisma.JsonValue | null | undefined): OdooStoredSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as unknown as OdooStoredSettings;
}

function parseIssues(raw: Prisma.JsonValue | null | undefined): OdooSyncIssue[] {
  if (!Array.isArray(raw)) return [];
  return raw as unknown as OdooSyncIssue[];
}

export function toOdooSyncRunView(run: OdooSyncRun): OdooSyncRunView {
  return {
    id: run.id,
    connectionId: run.connectionId,
    mode: run.mode,
    status: run.status,
    totalCount: run.totalCount,
    processedCount: run.processedCount,
    createdCount: run.createdCount,
    updatedCount: run.updatedCount,
    skippedCount: run.skippedCount,
    failedCount: run.failedCount,
    errorMessage: run.errorMessage,
    issues: parseIssues(run.issues),
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    createdAt: run.createdAt,
  };
}

@Injectable()
export class OdooConnectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly client: OdooReadOnlyClient,
    private readonly vault: OdooCredentialsVault,
    private readonly activity: ActivityRecorder,
  ) {}

  async getStatus(workspaceId: string): Promise<OdooConnectionView | null> {
    const connection = await this.prisma.odooConnection.findUnique({ where: { workspaceId } });
    if (!connection) return null;
    return this.toView(connection);
  }

  async testConnection(
    workspaceId: string,
    input: TestOdooConnectionInput,
  ): Promise<OdooTestConnectionResult> {
    try {
      const credentials = await this.resolveCredentialsForTest(workspaceId, input);
      const discovered = await this.client.discoverInstance(credentials);
      await this.prisma.odooConnection.updateMany({
        where: { workspaceId },
        data: { lastTestedAt: new Date() },
      });
      return { ok: true, error: null, discovered };
    } catch (error) {
      return { ok: false, error: describeError(error), discovered: null };
    }
  }

  async upsertConnection(
    workspaceId: string,
    input: UpsertOdooConnectionInput,
    actor: Actor,
  ): Promise<OdooConnectionView> {
    const existing = await this.prisma.odooConnection.findUnique({ where: { workspaceId } });
    const apiKey = await this.resolveApiKey(workspaceId, existing, input.apiKey);

    const credentials: OdooCredentialsInput = {
      url: input.url.trim().replace(/\/+$/, ''),
      database: input.database.trim(),
      username: input.username.trim(),
      apiKey,
    };

    if (existing) {
      const existingOrigin = buildOdooSourceOrigin(existing.url, existing.database);
      const nextOrigin = buildOdooSourceOrigin(credentials.url, credentials.database);
      if (existingOrigin !== nextOrigin) {
        const linkedProducts = await this.prisma.product.count({
          where: {
            workspaceId,
            sourceKind: CatalogSourceKind.ODOO,
          },
        });
        if (linkedProducts > 0) {
          throw new ConflictException(INSTANCE_CHANGE_BLOCKED);
        }
      }
    }

    const discovered = await this.client.discoverInstance(credentials);
    const sealedCredentials = await this.vault.seal(workspaceId, { apiKey });
    const existingSettings = parseStoredSettings(existing?.settings);
    const mergedSettings: OdooStoredSettings = {
      ...existingSettings,
      ...input.settings,
      discovered,
    };
    if (mergedSettings.brandField === undefined && discovered.brandField) {
      mergedSettings.brandField = discovered.brandField;
    }

    const displayName =
      input.displayName?.trim() || discovered.companyName || `Odoo (${credentials.database})`;
    const now = new Date();

    const saved = existing
      ? await this.prisma.odooConnection.update({
          where: { id: existing.id },
          data: {
            displayName,
            url: credentials.url,
            database: credentials.database,
            username: credentials.username,
            sealedCredentials,
            status: OdooConnectionStatus.CONNECTED,
            statusReason: null,
            settings: mergedSettings as unknown as Prisma.InputJsonValue,
            lastTestedAt: now,
            disconnectedAt: null,
          },
        })
      : await this.prisma.odooConnection.create({
          data: {
            workspaceId,
            displayName,
            url: credentials.url,
            database: credentials.database,
            username: credentials.username,
            sealedCredentials,
            status: OdooConnectionStatus.CONNECTED,
            statusReason: null,
            settings: mergedSettings as unknown as Prisma.InputJsonValue,
            connectedById: actor.userId ?? null,
            connectedAt: now,
            lastTestedAt: now,
          },
        });

    await this.activity.record(workspaceId, actor, {
      action:
        existing && existing.status === OdooConnectionStatus.CONNECTED
          ? ActivityAction.OdooCredentialsUpdated
          : ActivityAction.OdooConnected,
      subject: {
        type: ActivitySubjectType.OdooConnection,
        id: saved.id,
        label: saved.displayName,
      },
    });

    return this.toView(saved);
  }

  /**
   * Disconnects Odoo and wipes stored credentials. Imported products stay intact in Crossmart
   * with their source metadata and protection preserved.
   */
  async disconnect(workspaceId: string, actor: Actor): Promise<OdooConnectionView> {
    const existing = await this.prisma.odooConnection.findUnique({ where: { workspaceId } });
    if (!existing) {
      throw new NotFoundException(CONNECTION_NOT_FOUND);
    }

    const updated = await this.prisma.odooConnection.update({
      where: { id: existing.id },
      data: {
        status: OdooConnectionStatus.DISCONNECTED,
        sealedCredentials: null,
        statusReason: null,
        disconnectedAt: new Date(),
      },
    });

    await this.activity.record(workspaceId, actor, {
      action: ActivityAction.OdooDisconnected,
      subject: {
        type: ActivitySubjectType.OdooConnection,
        id: updated.id,
        label: updated.displayName,
      },
    });

    return this.toView(updated);
  }

  async previewProducts(
    workspaceId: string,
    options: { search?: string; limit?: number },
  ): Promise<OdooPreviewProduct[]> {
    const { connection, credentials, settings } = await this.openActiveConnection(workspaceId);
    const limit = Math.min(
      Math.max(1, options.limit ?? ODOO_DEFAULT_PREVIEW_LIMIT),
      ODOO_MAX_PREVIEW_LIMIT,
    );
    const rows = await this.client.previewProducts(credentials, {
      search: options.search,
      limit,
      settings,
    });
    if (rows.length === 0) return [];

    const existingProducts = await this.prisma.product.findMany({
      where: {
        workspaceId,
        sourceKind: CatalogSourceKind.ODOO,
        sourceConnectionId: connection.id,
        sourceExternalId: { in: rows.map((row) => String(row.templateId)) },
      },
      select: { id: true, sourceExternalId: true },
    });
    const productByExternalId = new Map(
      existingProducts.flatMap((item) =>
        item.sourceExternalId ? [[item.sourceExternalId, item.id]] : [],
      ),
    );

    return rows.map((row) => {
      const crossmartProductId = productByExternalId.get(String(row.templateId)) ?? null;
      return {
        ...row,
        alreadySynced: crossmartProductId !== null,
        crossmartProductId,
      };
    });
  }

  async downloadProductDocument(
    workspaceId: string,
    productId: string,
    documentId: string,
  ): Promise<{ name: string; mimetype: string; content: Buffer }> {
    const doc = await this.prisma.productDocument.findFirst({
      where: { id: documentId, productId, workspaceId },
      include: { product: { select: { sourceConnectionId: true } } },
    });
    if (!doc) {
      throw new NotFoundException(DOCUMENT_NOT_FOUND);
    }
    const attachmentId = Number(doc.sourceExternalId.replace(/^att:/, ''));
    if (!Number.isInteger(attachmentId) || attachmentId <= 0) {
      throw new NotFoundException(DOCUMENT_NOT_FOUND);
    }
    const { connection, credentials } = await this.openActiveConnection(workspaceId);
    if (doc.product.sourceConnectionId && doc.product.sourceConnectionId !== connection.id) {
      throw new NotFoundException(DOCUMENT_NOT_FOUND);
    }
    const file = await this.client.readAttachmentContent(credentials, attachmentId);
    if (!file) {
      throw new NotFoundException(DOCUMENT_NOT_FOUND);
    }
    return file;
  }

  async openActiveConnection(workspaceId: string): Promise<{
    connection: OdooConnection;
    credentials: OdooCredentialsInput;
    settings: OdooStoredSettings;
  }> {
    const connection = await this.prisma.odooConnection.findUnique({ where: { workspaceId } });
    if (!connection || connection.status === OdooConnectionStatus.DISCONNECTED) {
      throw new BadRequestException(CONNECTION_NOT_FOUND);
    }
    if (!connection.sealedCredentials) {
      throw new BadRequestException(CREDENTIALS_REQUIRED);
    }
    const secret = await this.vault.open(workspaceId, connection.sealedCredentials);
    return {
      connection,
      credentials: {
        url: connection.url,
        database: connection.database,
        username: connection.username,
        apiKey: secret.apiKey,
      },
      settings: parseStoredSettings(connection.settings),
    };
  }

  private async resolveCredentialsForTest(
    workspaceId: string,
    input: TestOdooConnectionInput,
  ): Promise<OdooCredentialsInput> {
    const existing = await this.prisma.odooConnection.findUnique({ where: { workspaceId } });
    const url = input.url?.trim() || existing?.url;
    const database = input.database?.trim() || existing?.database;
    const username = input.username?.trim() || existing?.username;
    if (!url || !database || !username) {
      throw new BadRequestException('URL, database, and username are required to test connection.');
    }
    const apiKey = await this.resolveApiKey(workspaceId, existing, input.apiKey);
    return { url, database, username, apiKey };
  }

  private async resolveApiKey(
    workspaceId: string,
    existing: OdooConnection | null,
    provided?: string,
  ): Promise<string> {
    const trimmed = provided?.trim();
    if (trimmed) return trimmed;
    if (existing?.sealedCredentials) {
      const secret = await this.vault.open(workspaceId, existing.sealedCredentials);
      return secret.apiKey;
    }
    throw new BadRequestException(CREDENTIALS_REQUIRED);
  }

  private async toView(connection: OdooConnection): Promise<OdooConnectionView> {
    const [syncedProductCount, recentRuns] = await Promise.all([
      this.prisma.product.count({
        where: {
          workspaceId: connection.workspaceId,
          sourceKind: CatalogSourceKind.ODOO,
          sourceConnectionId: connection.id,
        },
      }),
      this.prisma.odooSyncRun.findMany({
        where: { connectionId: connection.id },
        orderBy: { createdAt: 'desc' },
        take: RECENT_RUNS_LIMIT,
      }),
    ]);

    const stored = parseStoredSettings(connection.settings);
    const { discovered, ...advancedSettings } = stored;
    const mappedRuns = recentRuns.map(toOdooSyncRunView);

    return {
      id: connection.id,
      displayName: connection.displayName,
      url: connection.url,
      database: connection.database,
      username: connection.username,
      hasCredentials: Boolean(connection.sealedCredentials),
      status: connection.status,
      statusReason: connection.statusReason,
      settings: advancedSettings,
      discovered: (discovered as OdooDiscoveredCapabilities | undefined) ?? null,
      syncedProductCount,
      lastTestedAt: connection.lastTestedAt,
      lastSyncedAt: connection.lastSyncedAt,
      connectedAt: connection.connectedAt,
      disconnectedAt: connection.disconnectedAt,
      latestRun: mappedRuns[0] ?? null,
      recentRuns: mappedRuns,
    };
  }
}
