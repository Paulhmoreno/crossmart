import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { QueueName } from '@crossmart/common';
import {
  SOCIAL_PLANNING_INTERVAL_MS,
  SOCIAL_PLANNING_JOB_NAME,
  SOCIAL_PLANNING_SCHEDULER_ID,
} from '@crossmart/core';

/**
 * Registers Agente Social's periodic editorial planning cycle on Crossmart's existing
 * `maintenance` BullMQ queue. Automatically processes ONLY workspaces whose owner explicitly
 * authorized `autonomyMode === 'AUTOMATIC'` and `paused === false` (never publishes automatically).
 */
@Injectable()
export class SocialPlanningScheduler implements OnApplicationBootstrap {
  constructor(@InjectQueue(QueueName.Maintenance) private readonly maintenance: Queue) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.maintenance.upsertJobScheduler(
      SOCIAL_PLANNING_SCHEDULER_ID,
      { every: SOCIAL_PLANNING_INTERVAL_MS },
      { name: SOCIAL_PLANNING_JOB_NAME, data: {} },
    );
  }
}
