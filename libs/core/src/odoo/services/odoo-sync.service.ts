import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { describeError, sanitizeDescriptionHtml } from '@crossmart/common';
import {
  CatalogSourceKind,
  InventoryMovementReason,
  OdooConnectionStatus,
  OdooSyncMode,
  OdooSyncRunStatus,
  OutOfStockPolicy,
  type Prisma,
  PrismaService,
  ProductStatus,
} from '@crossmart/database';
import { Actor } from '../../activity/entities/actor.js';
import { ActivityAction } from '../../activity/enums/activity-action.enum.js';
import { ActivitySubjectType } from '../../activity/enums/activity-subject-type.enum.js';
import { ActivityRecorder } from '../../activity/services/activity-recorder.js';
import { CatalogChangeKind } from '../../events/enums/catalog-change-kind.enum.js';
import { CatalogEventBus } from '../../events/services/catalog-event-bus.js';
import { InventoryLedger } from '../../inventory/repositories/inventory-ledger.js';
import { MediaService } from '../../media/services/media.service.js';
import {
  OdooReadOnlyClient,
  type OdooTemplateSnapshot,
  type OdooVariantSnapshot,
} from '../client/odoo-readonly.client.js';
import type {
  OdooSyncFilterInput,
  OdooSyncIssue,
  OdooSyncJobRef,
  OdooSyncRequestInput,
  OdooSyncRunView,
} from '../entities/odoo-connection.js';
import { ODOO_MAX_SYNC_ISSUES } from '../odoo.constants.js';
import { OdooSyncQueue } from '../queue/odoo-sync.queue.js';
import {
  buildOdooMediaKey,
  classifyOdooAttachment,
  formatOdooDecimal,
  kgToGrams,
  sha256Hex,
} from '../rules/odoo-document-classifier.js';
import { OdooConnectionService, toOdooSyncRunView } from './odoo-connection.service.js';

const BATCH_SIZE = 10;
const MAX_HANDLE_LENGTH = 80;
const SYNC_ALREADY_RUNNING = 'An Odoo sync is already in progress for this workspace.';
const SYNC_RUN_NOT_FOUND = 'Odoo sync run not found.';
const SELECTED_FILTER_REQUIRED =
  'Select at least one product (template ID, SKU, or barcode) for a selective sync.';

function slugifyHandle(input: string, fallbackId: number): string {
  const base = input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_HANDLE_LENGTH);
  return base || `odoo-${fallbackId}`;
}

function buildSourceMetadata(
  template: OdooTemplateSnapshot,
  currency: string,
  syncedAt: Date,
): Prisma.InputJsonValue {
  return {
    originalName: template.name,
    originalBrand: template.brand,
    originalCategory: template.category,
    currency,
    taxes: template.taxNames,
    weightKg: template.weightKg,
    volume: template.volume,
    customFields: template.customFieldValues,
    lastSyncedAt: syncedAt.toISOString(),
  } as Prisma.InputJsonValue;
}

@Injectable()
export class OdooSyncService {
  private readonly logger = new Logger(OdooSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connections: OdooConnectionService,
    private readonly client: OdooReadOnlyClient,
    private readonly queue: OdooSyncQueue,
    private readonly media: MediaService,
    private readonly ledger: InventoryLedger,
    private readonly activity: ActivityRecorder,
    private readonly events: CatalogEventBus,
  ) {}

  async startSync(
    workspaceId: string,
    request: OdooSyncRequestInput,
    actor: Actor,
  ): Promise<OdooSyncRunView> {
    const { connection } = await this.connections.openActiveConnection(workspaceId);

    if (request.mode === OdooSyncMode.SELECTED) {
      const filter = request.filter;
      const hasSelector =
        (filter?.templateIds?.length ?? 0) > 0 ||
        (filter?.skus?.length ?? 0) > 0 ||
        (filter?.barcodes?.length ?? 0) > 0;
      if (!hasSelector) {
        throw new BadRequestException(SELECTED_FILTER_REQUIRED);
      }
    }

    const activeRun = await this.prisma.odooSyncRun.findFirst({
      where: {
        connectionId: connection.id,
        status: { in: [OdooSyncRunStatus.QUEUED, OdooSyncRunStatus.RUNNING] },
      },
      select: { id: true },
    });
    if (activeRun) {
      throw new ConflictException(SYNC_ALREADY_RUNNING);
    }

    const run = await this.prisma.odooSyncRun.create({
      data: {
        workspaceId,
        connectionId: connection.id,
        mode: request.mode,
        status: OdooSyncRunStatus.QUEUED,
        filter: (request.filter ?? {}) as unknown as Prisma.InputJsonValue,
        actorUserId: actor.userId ?? null,
      },
    });

    await this.activity.record(workspaceId, actor, {
      action: ActivityAction.OdooSyncRequested,
      subject: {
        type: ActivitySubjectType.OdooConnection,
        id: connection.id,
        label: connection.displayName,
      },
      detail: request.mode === OdooSyncMode.FULL ? 'full catalog' : 'selected products',
    });

    await this.queue.enqueue({ workspaceId, runId: run.id });
    return toOdooSyncRunView(run);
  }

  async getSyncRun(workspaceId: string, runId: string): Promise<OdooSyncRunView> {
    const run = await this.prisma.odooSyncRun.findFirst({
      where: { id: runId, workspaceId },
    });
    if (!run) {
      throw new NotFoundException(SYNC_RUN_NOT_FOUND);
    }
    return toOdooSyncRunView(run);
  }

  /** Executed by the BullMQ worker (`OdooSyncProcessor`). */
  async runSync(job: OdooSyncJobRef): Promise<void> {
    const run = await this.prisma.odooSyncRun.findFirst({
      where: { id: job.runId, workspaceId: job.workspaceId },
    });
    if (!run) return;

    const startedAt = new Date();
    await this.prisma.odooSyncRun.update({
      where: { id: run.id },
      data: { status: OdooSyncRunStatus.RUNNING, startedAt, errorMessage: null },
    });

    const issues: OdooSyncIssue[] = [];
    const changedProductIds: string[] = [];
    let createdCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    let processedCount = 0;

    try {
      const { connection, credentials, settings } = await this.connections.openActiveConnection(
        job.workspaceId,
      );
      const filter = (run.filter ?? {}) as OdooSyncFilterInput;
      const templateIds = await this.client.resolveTemplateIds(credentials, filter, settings);

      await this.prisma.odooSyncRun.update({
        where: { id: run.id },
        data: { totalCount: templateIds.length },
      });

      const currency = settings.discovered?.currency ?? 'USD';

      for (let offset = 0; offset < templateIds.length; offset += BATCH_SIZE) {
        const chunk = templateIds.slice(offset, offset + BATCH_SIZE);
        const snapshots = await this.client.fetchTemplateBatch(credentials, chunk, settings);

        for (const snapshot of snapshots) {
          try {
            const outcome = await this.syncTemplate(
              job.workspaceId,
              connection.id,
              snapshot,
              settings,
              currency,
            );
            if (outcome.action === 'created') createdCount += 1;
            else if (outcome.action === 'updated') updatedCount += 1;
            else skippedCount += 1;
            if (outcome.productId) changedProductIds.push(outcome.productId);
          } catch (error) {
            failedCount += 1;
            if (issues.length < ODOO_MAX_SYNC_ISSUES) {
              issues.push({
                externalId: String(snapshot.id),
                name: snapshot.name,
                message: describeError(error),
              });
            }
            this.logger.warn(
              `Odoo sync failed for template ${snapshot.id} (${snapshot.name}): ${describeError(error)}`,
            );
          } finally {
            processedCount += 1;
          }
        }

        await this.prisma.odooSyncRun.update({
          where: { id: run.id },
          data: {
            processedCount,
            createdCount,
            updatedCount,
            skippedCount,
            failedCount,
            issues: issues as unknown as Prisma.InputJsonValue,
          },
        });
      }

      const finishedAt = new Date();
      await this.prisma.$transaction([
        this.prisma.odooSyncRun.update({
          where: { id: run.id },
          data: {
            status: OdooSyncRunStatus.COMPLETED,
            processedCount,
            createdCount,
            updatedCount,
            skippedCount,
            failedCount,
            issues: issues as unknown as Prisma.InputJsonValue,
            finishedAt,
          },
        }),
        this.prisma.odooConnection.update({
          where: { id: connection.id },
          data: {
            status: OdooConnectionStatus.CONNECTED,
            statusReason: null,
            lastSyncedAt: finishedAt,
          },
        }),
      ]);

      if (changedProductIds.length > 0) {
        await this.events.productsChanged({
          workspaceId: job.workspaceId,
          productIds: changedProductIds,
          kinds: [CatalogChangeKind.Content, CatalogChangeKind.Price, CatalogChangeKind.Stock],
        });
      }

      await this.activity.record(job.workspaceId, Actor.system(), {
        action: ActivityAction.OdooSyncCompleted,
        subject: {
          type: ActivitySubjectType.OdooConnection,
          id: connection.id,
          label: connection.displayName,
        },
        itemCount: createdCount + updatedCount,
        detail: `${createdCount} new, ${updatedCount} updated, ${failedCount} failed`,
      });
    } catch (error) {
      const reason = describeError(error);
      this.logger.error(`Odoo sync run ${run.id} failed: ${reason}`);
      await this.prisma.$transaction([
        this.prisma.odooSyncRun.update({
          where: { id: run.id },
          data: {
            status: OdooSyncRunStatus.FAILED,
            errorMessage: reason,
            processedCount,
            createdCount,
            updatedCount,
            skippedCount,
            failedCount,
            issues: issues as unknown as Prisma.InputJsonValue,
            finishedAt: new Date(),
          },
        }),
        this.prisma.odooConnection.update({
          where: { id: run.connectionId },
          data: {
            status: OdooConnectionStatus.ERROR,
            statusReason: reason,
          },
        }),
      ]);
      throw error;
    }
  }

  private async syncTemplate(
    workspaceId: string,
    connectionId: string,
    template: OdooTemplateSnapshot,
    settings: { stockField?: import('../odoo.constants.js').OdooStockField },
    currency: string,
  ): Promise<{ action: 'created' | 'updated' | 'skipped'; productId: string | null }> {
    const externalId = String(template.id);
    const syncedAt = new Date();
    const sourceMetadata = buildSourceMetadata(template, currency, syncedAt);

    const existing = await this.prisma.product.findFirst({
      where: {
        workspaceId,
        sourceKind: CatalogSourceKind.ODOO,
        sourceExternalId: externalId,
      },
      include: {
        variants: { include: { inventoryItem: true }, orderBy: { position: 'asc' } },
        media: { orderBy: { position: 'asc' } },
        documents: true,
      },
    });

    const variantsToSync: OdooVariantSnapshot[] =
      template.variants.length > 0
        ? template.variants
        : [
            {
              id: template.id,
              sku: template.sku,
              barcode: template.barcode,
              price: template.listPrice,
              cost: template.cost,
              weightKg: template.weightKg,
              volume: template.volume,
              qtyAvailable: 0,
              freeQty: 0,
              optionValues: [],
              imageBase64: null,
            },
          ];

    // Check SKU conflicts against OTHER products before mutating anything
    const incomingSkus = variantsToSync.flatMap((item) => (item.sku ? [item.sku] : []));
    if (incomingSkus.length > 0) {
      const conflicting = await this.prisma.variant.findFirst({
        where: {
          workspaceId,
          sku: { in: incomingSkus },
          ...(existing ? { productId: { not: existing.id } } : {}),
        },
        select: { sku: true },
      });
      if (conflicting?.sku) {
        throw new Error(`SKU "${conflicting.sku}" already belongs to another product in Crossmart`);
      }
    }

    // Prepare media candidates & private document classifications
    const { desiredMedia, desiredDocuments } = await this.prepareMediaAndDocuments(
      workspaceId,
      template,
      existing?.media ?? [],
    );

    if (!existing) {
      const handle = await this.allocateUniqueHandle(workspaceId, template.name, template.id);
      const created = await this.prisma.product.create({
        data: {
          workspaceId,
          sourceKind: CatalogSourceKind.ODOO,
          sourceConnectionId: connectionId,
          sourceExternalId: externalId,
          sourceMetadata,
          handle,
          title: template.name,
          descriptionHtml: template.descriptionHtml
            ? sanitizeDescriptionHtml(template.descriptionHtml)
            : '',
          vendor: template.brand,
          productType: template.category,
          tags: [],
          status: ProductStatus.DRAFT,
          optionNames: template.optionNames,
          variants: {
            create: variantsToSync.map((variant, position) => {
              const available = this.client.selectStockQuantity(variant, settings.stockField);
              return {
                workspaceId,
                sourceExternalId: String(variant.id),
                position,
                sku: variant.sku,
                barcode: variant.barcode,
                optionValues: variant.optionValues,
                price: formatOdooDecimal(variant.price),
                cost: variant.cost !== null ? formatOdooDecimal(variant.cost) : null,
                weightGrams: kgToGrams(variant.weightKg),
                requiresShipping: true,
                taxable: template.taxable,
                outOfStockPolicy: OutOfStockPolicy.STOP_SELLING,
                inventoryItem: {
                  create: {
                    workspaceId,
                    tracked: true,
                    available,
                    movements:
                      available === 0
                        ? undefined
                        : {
                            create: {
                              workspaceId,
                              delta: available,
                              quantityAfter: available,
                              reason: InventoryMovementReason.OPENING_BALANCE,
                              note: 'Imported from Odoo',
                            },
                          },
                  },
                },
              };
            }),
          },
          media: {
            create: desiredMedia.map((item, position) => ({
              workspaceId,
              url: item.url,
              altText: item.altText,
              position,
              sourceManaged: true,
              sourceKey: item.sourceKey,
            })),
          },
          documents: {
            create: desiredDocuments.map((doc) => ({
              workspaceId,
              sourceExternalId: doc.sourceExternalId,
              name: doc.name,
              mimetype: doc.mimetype,
              byteSize: doc.byteSize,
              kind: doc.kind,
              isPublic: doc.isPublic,
              checksum: doc.checksum,
            })),
          },
        },
        select: { id: true },
      });
      return { action: 'created', productId: created.id };
    }

    // Repeat sync: preserve commercial fields (`title`, `descriptionHtml`, `tags`, `productType`,
    // `status`, `condition`, and manual photos). Update ERP-owned fields only!
    await this.prisma.$transaction(async (tx) => {
      await tx.product.update({
        where: { id: existing.id },
        data: {
          sourceConnectionId: connectionId,
          sourceMetadata,
          optionNames: template.optionNames,
          ...(existing.vendor ? {} : { vendor: template.brand }),
        },
      });

      const existingVariantByExternalId = new Map(
        existing.variants.flatMap((item) =>
          item.sourceExternalId ? [[item.sourceExternalId, item]] : [],
        ),
      );
      const inventoryIdsToLock = existing.variants.flatMap((item) =>
        item.inventoryItem ? [item.inventoryItem.id] : [],
      );
      const lockedStocks = await this.ledger.lockItems(tx, workspaceId, inventoryIdsToLock);
      const lockedByVariantId = new Map(lockedStocks.map((stock) => [stock.variantId, stock]));

      for (const [position, variant] of variantsToSync.entries()) {
        const variantExtId = String(variant.id);
        const existingVariant =
          existingVariantByExternalId.get(variantExtId) ??
          (variantsToSync.length === 1 && existing.variants.length === 1
            ? existing.variants[0]
            : undefined);
        const targetAvailable = this.client.selectStockQuantity(variant, settings.stockField);

        if (existingVariant) {
          await tx.variant.update({
            where: { id: existingVariant.id },
            data: {
              sourceExternalId: variantExtId,
              position,
              sku: variant.sku,
              barcode: variant.barcode,
              optionValues: variant.optionValues,
              price: formatOdooDecimal(variant.price),
              cost: variant.cost !== null ? formatOdooDecimal(variant.cost) : null,
              weightGrams: kgToGrams(variant.weightKg),
              taxable: template.taxable,
            },
          });

          const locked = lockedByVariantId.get(existingVariant.id);
          if (locked) {
            if (!locked.tracked) {
              await tx.inventoryItem.update({
                where: { id: locked.id },
                data: { tracked: true },
              });
            }
            const availableDelta = targetAvailable - locked.available;
            if (availableDelta !== 0) {
              await this.ledger.applyMovement(tx, workspaceId, {
                stock: locked,
                availableDelta,
                reservedDelta: 0,
                entry: {
                  reason: InventoryMovementReason.IMPORTED,
                  actor: Actor.system(),
                  note: 'Synced from Odoo',
                },
              });
            }
          }
        } else {
          await tx.variant.create({
            data: {
              workspaceId,
              productId: existing.id,
              sourceExternalId: variantExtId,
              position,
              sku: variant.sku,
              barcode: variant.barcode,
              optionValues: variant.optionValues,
              price: formatOdooDecimal(variant.price),
              cost: variant.cost !== null ? formatOdooDecimal(variant.cost) : null,
              weightGrams: kgToGrams(variant.weightKg),
              requiresShipping: true,
              taxable: template.taxable,
              outOfStockPolicy: OutOfStockPolicy.STOP_SELLING,
              inventoryItem: {
                create: {
                  workspaceId,
                  tracked: true,
                  available: targetAvailable,
                  movements:
                    targetAvailable === 0
                      ? undefined
                      : {
                          create: {
                            workspaceId,
                            delta: targetAvailable,
                            quantityAfter: targetAvailable,
                            reason: InventoryMovementReason.IMPORTED,
                            note: 'Synced from Odoo',
                          },
                        },
                },
              },
            },
          });
        }
      }

      // Sync source-managed media without touching manually uploaded commercial images
      const manualMedia = existing.media.filter((item) => !item.sourceManaged);
      await tx.productMedia.deleteMany({
        where: { productId: existing.id, workspaceId, sourceManaged: true },
      });
      const combinedMedia = [
        ...desiredMedia.map((item) => ({
          url: item.url,
          altText: item.altText,
          sourceManaged: true,
          sourceKey: item.sourceKey,
        })),
        ...manualMedia.map((item) => ({
          url: item.url,
          altText: item.altText,
          sourceManaged: false,
          sourceKey: null,
        })),
      ];
      await tx.productMedia.deleteMany({ where: { productId: existing.id, workspaceId } });
      if (combinedMedia.length > 0) {
        await tx.productMedia.createMany({
          data: combinedMedia.map((item, position) => ({
            workspaceId,
            productId: existing.id,
            url: item.url,
            altText: item.altText,
            position,
            sourceManaged: item.sourceManaged,
            sourceKey: item.sourceKey,
          })),
        });
      }

      // Upsert private reference documents (datasheets, manuals, internal files)
      const desiredDocIds = desiredDocuments.map((doc) => doc.sourceExternalId);
      await tx.productDocument.deleteMany({
        where: {
          productId: existing.id,
          workspaceId,
          ...(desiredDocIds.length > 0 ? { sourceExternalId: { notIn: desiredDocIds } } : {}),
        },
      });
      for (const doc of desiredDocuments) {
        await tx.productDocument.upsert({
          where: {
            productId_sourceExternalId: {
              productId: existing.id,
              sourceExternalId: doc.sourceExternalId,
            },
          },
          create: {
            workspaceId,
            productId: existing.id,
            sourceExternalId: doc.sourceExternalId,
            name: doc.name,
            mimetype: doc.mimetype,
            byteSize: doc.byteSize,
            kind: doc.kind,
            isPublic: doc.isPublic,
            checksum: doc.checksum,
          },
          update: {
            name: doc.name,
            mimetype: doc.mimetype,
            byteSize: doc.byteSize,
            kind: doc.kind,
            isPublic: doc.isPublic,
            checksum: doc.checksum,
          },
        });
      }
    });

    return { action: 'updated', productId: existing.id };
  }

  private async prepareMediaAndDocuments(
    workspaceId: string,
    template: OdooTemplateSnapshot,
    existingMedia: {
      url: string;
      altText: string | null;
      sourceManaged: boolean;
      sourceKey: string | null;
    }[],
  ): Promise<{
    desiredMedia: { url: string; altText: string | null; sourceKey: string }[];
    desiredDocuments: {
      sourceExternalId: string;
      name: string;
      mimetype: string;
      byteSize: number | null;
      kind: import('@crossmart/database').ProductDocumentKind;
      isPublic: boolean;
      checksum: string | null;
    }[];
  }> {
    const existingUrlByKey = new Map<string, string>();
    for (const media of existingMedia) {
      if (media.sourceManaged && media.sourceKey) {
        existingUrlByKey.set(media.sourceKey, media.url);
      }
    }

    const desiredMedia: { url: string; altText: string | null; sourceKey: string }[] = [];
    const seenHashes = new Set<string>();

    const addImageIfNew = async (
      prefix: string,
      externalId: string | number,
      base64: string,
      altText: string,
    ): Promise<void> => {
      const buffer = Buffer.from(base64, 'base64');
      if (buffer.byteLength === 0) return;
      const hash = sha256Hex(buffer);
      if (seenHashes.has(hash)) return;
      seenHashes.add(hash);

      const sourceKey = buildOdooMediaKey(prefix, externalId, hash);
      const cachedUrl = existingUrlByKey.get(sourceKey);
      if (cachedUrl) {
        desiredMedia.push({ url: cachedUrl, altText, sourceKey });
        return;
      }
      try {
        const uploaded = await this.media.uploadProductImage(workspaceId, buffer);
        desiredMedia.push({ url: uploaded.url, altText, sourceKey });
      } catch (error) {
        this.logger.warn(
          `Skipped invalid/unsupported Odoo image (${sourceKey}): ${describeError(error)}`,
        );
      }
    };

    // 1. Main template image (`image_1920`)
    if (template.mainImageBase64) {
      await addImageIfNew('tmpl', template.id, template.mainImageBase64, template.name);
    }

    // 2. Variant-specific images (only when distinct from main image)
    for (const variant of template.variants) {
      if (variant.imageBase64) {
        const label =
          variant.optionValues.length > 0
            ? `${template.name} - ${variant.optionValues.join(' / ')}`
            : template.name;
        await addImageIfNew('var', variant.id, variant.imageBase64, label);
      }
    }

    // 3. `product.document` & `ir.attachment` entries: separate commercial photos vs technical docs
    const desiredDocuments: {
      sourceExternalId: string;
      name: string;
      mimetype: string;
      byteSize: number | null;
      kind: import('@crossmart/database').ProductDocumentKind;
      isPublic: boolean;
      checksum: string | null;
    }[] = [];

    for (const attachment of template.attachments) {
      const classification = classifyOdooAttachment(attachment.name, attachment.mimetype);
      if (classification.isCommercialImage && attachment.datasBase64) {
        await addImageIfNew('doc', attachment.id, attachment.datasBase64, attachment.name);
      } else {
        const checksum = attachment.datasBase64
          ? sha256Hex(Buffer.from(attachment.datasBase64, 'base64'))
          : null;
        desiredDocuments.push({
          sourceExternalId: `att:${attachment.id}`,
          name: attachment.name,
          mimetype: attachment.mimetype,
          byteSize: attachment.fileSize,
          kind: classification.documentKind,
          isPublic: attachment.isPublic,
          checksum,
        });
      }
    }

    return { desiredMedia, desiredDocuments };
  }

  private async allocateUniqueHandle(
    workspaceId: string,
    name: string,
    templateId: number,
  ): Promise<string> {
    const base = slugifyHandle(name, templateId);
    const existing = await this.prisma.product.findFirst({
      where: { workspaceId, handle: base },
      select: { id: true },
    });
    if (!existing) return base;
    return `${base}-odoo-${templateId}`;
  }
}
