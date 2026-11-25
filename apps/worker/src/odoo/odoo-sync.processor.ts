import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { QueueName } from '@crossmart/common';
import { type OdooSyncJobRef, OdooSyncService } from '@crossmart/core';

/** Executes read-only Odoo catalog sync jobs on the dedicated `odoo-sync` queue. */
@Processor(QueueName.OdooSync)
export class OdooSyncProcessor extends WorkerHost {
  private readonly logger = new Logger(OdooSyncProcessor.name);

  constructor(private readonly sync: OdooSyncService) {
    super();
  }

  async process(job: Job<OdooSyncJobRef>): Promise<void> {
    this.logger.log(
      `Processing Odoo sync run ${job.data.runId} for workspace ${job.data.workspaceId}`,
    );
    await this.sync.runSync(job.data);
  }
}
