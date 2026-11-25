import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { QueueName } from '@crossmart/common';
import type { OdooSyncJobRef } from '../entities/odoo-connection.js';
import {
  ODOO_SYNC_BACKOFF_MS,
  ODOO_SYNC_JOB_ATTEMPTS,
  ODOO_SYNC_JOB_NAME,
} from '../odoo.constants.js';

export abstract class OdooSyncQueue {
  abstract enqueue(job: OdooSyncJobRef): Promise<void>;
}

@Injectable()
export class BullOdooSyncQueue extends OdooSyncQueue {
  constructor(@InjectQueue(QueueName.OdooSync) private readonly queue: Queue<OdooSyncJobRef>) {
    super();
  }

  async enqueue(job: OdooSyncJobRef): Promise<void> {
    await this.queue.add(ODOO_SYNC_JOB_NAME, job, {
      jobId: job.runId,
      attempts: ODOO_SYNC_JOB_ATTEMPTS,
      backoff: { type: 'exponential', delay: ODOO_SYNC_BACKOFF_MS },
      removeOnComplete: 50,
      removeOnFail: 100,
    });
  }
}
