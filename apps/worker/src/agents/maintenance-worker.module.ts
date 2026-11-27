import { Module } from '@nestjs/common';
import {
  AgentProposalsStorageModule,
  AgentsModule,
  AgentWorkerStorageModule,
  AskStorageModule,
  SandboxModule,
  SocialAgentModule,
} from '@crossmart/core';
import { AgentClientSweepScheduler } from './agent-client-sweep.scheduler.js';
import { AgentProposalExpiryScheduler } from './agent-proposal-expiry.scheduler.js';
import { AgentWorkerRetentionScheduler } from './agent-worker-retention.scheduler.js';
import { AskRetentionScheduler } from './ask-retention.scheduler.js';
import { ConversationRetention } from './conversation-retention.js';
import { MaintenanceProcessor } from './maintenance.processor.js';
import { SandboxSweepScheduler } from './sandbox-sweep.scheduler.js';
import { SocialPlanningScheduler } from './social-planning.scheduler.js';

/**
 * Scheduled housekeeping: unused agent clients, sandbox account reminders and expiry, and the
 * retention of Ask Crossmart's and Agent Worker's conversations, expiry of outside agents'
 * proposals, and authorized Social Agent periodic editorial planning.
 */
@Module({
  imports: [
    AgentsModule,
    AgentWorkerStorageModule,
    AgentProposalsStorageModule,
    AskStorageModule,
    SandboxModule,
    SocialAgentModule,
  ],
  providers: [
    MaintenanceProcessor,
    ConversationRetention,
    AgentClientSweepScheduler,
    AskRetentionScheduler,
    AgentWorkerRetentionScheduler,
    AgentProposalExpiryScheduler,
    SandboxSweepScheduler,
    SocialPlanningScheduler,
  ],
})
export class MaintenanceWorkerModule {}
