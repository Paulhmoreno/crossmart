import { Module } from '@nestjs/common';
import { ActivityModule } from '../activity/activity.module.js';
import { AiModule } from '../ai/ai.module.js';
import { OdooModule } from '../odoo/odoo.module.js';
import { SalesAgentModule } from '../sales-agent/sales-agent.module.js';
import { SocialAgentService } from './social-agent.service.js';
import { SocialAgentToolsService } from './social-agent-tools.service.js';
import { SocialIntelligenceService } from './social-intelligence.service.js';
import { TryPostConnectionService } from './trypost-connection.service.js';
import { TryPostClient } from './trypost.client.js';

@Module({
  imports: [ActivityModule, AiModule, OdooModule, SalesAgentModule],
  providers: [
    TryPostClient,
    TryPostConnectionService,
    SocialIntelligenceService,
    SocialAgentToolsService,
    SocialAgentService,
  ],
  exports: [
    TryPostClient,
    TryPostConnectionService,
    SocialIntelligenceService,
    SocialAgentToolsService,
    SocialAgentService,
  ],
})
export class SocialAgentModule {}
