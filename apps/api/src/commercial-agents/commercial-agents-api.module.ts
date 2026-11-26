import { Module } from '@nestjs/common';
import { ChatwootModule, SalesAgentModule } from '@crossmart/core';
import { ChatwootController } from './chatwoot.controller.js';
import { ChatwootWebhookController } from './chatwoot-webhook.controller.js';
import { CommercialAgentsController } from './commercial-agents.controller.js';

@Module({
  imports: [ChatwootModule, SalesAgentModule],
  controllers: [ChatwootController, ChatwootWebhookController, CommercialAgentsController],
})
export class CommercialAgentsApiModule {}
