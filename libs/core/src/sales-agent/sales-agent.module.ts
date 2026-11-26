import { Module } from '@nestjs/common';
import { ActivityModule } from '../activity/activity.module.js';
import { AiModule } from '../ai/ai.module.js';
import { ChatwootModule } from '../chatwoot/chatwoot.module.js';
import { ListingsModule } from '../listings/listings.module.js';
import { AgentConfigsService } from './agent-configs.service.js';
import { SalesAgentService } from './sales-agent.service.js';
import { SalesAgentToolsService } from './sales-agent-tools.service.js';

@Module({
  imports: [ActivityModule, AiModule, ChatwootModule, ListingsModule],
  providers: [AgentConfigsService, SalesAgentToolsService, SalesAgentService],
  exports: [AgentConfigsService, SalesAgentToolsService, SalesAgentService],
})
export class SalesAgentModule {}
