import { BadRequestException, ForbiddenException, Inject, Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '@crossmart/database';
import { ActivityRecorder } from '../../activity/services/activity-recorder.js';
import { CatalogChangeKind } from '../../events/enums/catalog-change-kind.enum.js';
import { CatalogEventBus } from '../../events/services/catalog-event-bus.js';
import { CatalogImportMode } from '../enums/catalog-import-mode.enum.js';
import { CATALOG_IMPORT_STRATEGIES } from '../catalog.constants.js';
import type {
  CatalogImportRequest,
  CatalogImportResult,
  CatalogImportStrategy,
  ImportOutcome,
} from '../entities/catalog-import.js';
import { toImportActivityEntry, toImportEntry } from '../rules/import-activity.js';
import { ODOO_EXCLUSIVE_CATALOG_IMPORT_MESSAGE } from '../rules/source-ownership.rules.js';
import { ImportJobsService } from './import-jobs.service.js';

/**
 * Imports a catalog file in one of the `CatalogImportMode`s and records it in the import
 * history and the activity log, whether it succeeds or the file is rejected.
 */
@Injectable()
export class CatalogImportService {
  constructor(
    @Inject(CATALOG_IMPORT_STRATEGIES) private readonly strategies: CatalogImportStrategy[],
    private readonly jobs: ImportJobsService,
    private readonly activity: ActivityRecorder,
    private readonly events: CatalogEventBus,
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  async importFile(
    workspaceId: string,
    request: CatalogImportRequest,
  ): Promise<CatalogImportResult> {
    if (
      this.prisma &&
      (request.mode === CatalogImportMode.Create || request.mode === CatalogImportMode.Inventory)
    ) {
      const exclusiveOdoo = await this.prisma.odooConnection.findUnique({
        where: { workspaceId },
        select: { id: true },
      });
      if (exclusiveOdoo) {
        throw new ForbiddenException(ODOO_EXCLUSIVE_CATALOG_IMPORT_MESSAGE);
      }
    }
    const strategy = this.strategyFor(request);
    const { mode, format, fileName, actor } = request;
    const jobId = await this.jobs.start(workspaceId, { mode, format, fileName, actor });
    const file = { mode, jobId, fileName };
    let outcome: ImportOutcome;
    try {
      outcome = await strategy.run(workspaceId, request);
      await this.jobs.complete(workspaceId, jobId, outcome);
    } catch (error) {
      await this.jobs.fail(workspaceId, jobId, error);
      await this.activity.recordFailure(workspaceId, actor, toImportEntry(file), error);
      throw error;
    }
    await this.activity.record(workspaceId, actor, toImportActivityEntry(file, outcome));
    if (mode === CatalogImportMode.Update) {
      await this.events.productsChanged({
        workspaceId,
        productIds: outcome.productIds,
        kinds: [CatalogChangeKind.Content, CatalogChangeKind.Price],
      });
    }
    const { productIds: _productIds, ...counts } = outcome;
    return { ...counts, jobId, mode };
  }

  /** A mode that cannot read the format is a bad request, not a failed import. */
  private strategyFor({ mode, format }: CatalogImportRequest): CatalogImportStrategy {
    const strategy = this.strategies.find((candidate) => candidate.mode === mode);
    if (!strategy) {
      throw new BadRequestException(`Unsupported import mode: ${mode}`);
    }
    if (!strategy.supports(format)) {
      throw new BadRequestException(`A ${mode} import cannot read ${format} files`);
    }
    return strategy;
  }
}
