import { Module } from '@nestjs/common';
import { ActivityModule } from '../activity/activity.module.js';
import { AiModule } from '../ai/ai.module.js';
import { OdooModule } from '../odoo/odoo.module.js';
import { SalesAgentModule } from '../sales-agent/sales-agent.module.js';
import { SocialAgentService } from './social-agent.service.js';
import { SocialIntelligenceService } from './social-intelligence.service.js';
import { TryPostConnectionService } from './trypost-connection.service.js';
import { TryPostClient } from './trypost.client.js';

@Module({
  imports: [ActivityModule, AiModule, OdooModule, SalesAgentModule],
  providers: [
    TryPostClient,
    TryPostConnectionService,
    SocialIntelligenceService,
    SocialAgentService,
  ],
  exports: [
    TryPostClient,
    TryPostConnectionService,
    SocialIntelligenceService,
    SocialAgentService,
  ],
})
export class SocialAgentModule {}
