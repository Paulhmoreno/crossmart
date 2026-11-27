import { Module } from '@nestjs/common';
import { ChatwootModule, SalesAgentModule, SocialAgentModule } from '@crossmart/core';
import { ChatwootController } from './chatwoot.controller.js';
import { ChatwootWebhookController } from './chatwoot-webhook.controller.js';
import { CommercialAgentsController } from './commercial-agents.controller.js';
import { SocialAgentController } from './social-agent.controller.js';
import { TryPostController } from './trypost.controller.js';

@Module({
  imports: [ChatwootModule, SalesAgentModule, SocialAgentModule],
  controllers: [
    ChatwootController,
    ChatwootWebhookController,
    CommercialAgentsController,
    TryPostController,
    SocialAgentController,
  ],
})
export class CommercialAgentsApiModule {}
