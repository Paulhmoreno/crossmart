import { Module } from '@nestjs/common';
import { ActivityModule } from '../activity/activity.module.js';
import { CredentialsModule } from '../credentials/credentials.module.js';
import { ChatwootClient } from './chatwoot.client.js';
import { ChatwootConnectionsService } from './chatwoot-connections.service.js';
import { ChatwootCredentialsVault } from './chatwoot-credentials.vault.js';

@Module({
  imports: [CredentialsModule, ActivityModule],
  providers: [ChatwootClient, ChatwootCredentialsVault, ChatwootConnectionsService],
  exports: [ChatwootClient, ChatwootConnectionsService],
})
export class ChatwootModule {}
