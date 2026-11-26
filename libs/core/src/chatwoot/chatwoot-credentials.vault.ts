import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { EnvelopeEncryption } from '@crossmart/common';

const CHATWOOT_CREDENTIALS_CONTEXT = 'workspace-chatwoot-connection';
const ENCRYPTION_NOT_CONFIGURED =
  'Credentials encryption is not configured on the server (set CREDENTIALS_MASTER_KEY).';

export interface ChatwootSealedCredentials {
  /** Administrative/account REST token used to discover accounts, inboxes, and manage bot setup. */
  apiAccessToken: string;
  /** Optional dedicated AgentBot token used for daily buyer replies and handoffs. */
  agentBotToken?: string | null;
  /** Optional webhook shared secret for authenticating incoming Chatwoot webhook deliveries. */
  webhookSecret?: string | null;
}

/**
 * Seals and opens Chatwoot connection credentials using Crossmart's native per-workspace
 * AES-256-GCM envelope encryption. Never logs or returns secrets.
 */
@Injectable()
export class ChatwootCredentialsVault {
  constructor(private readonly encryption: EnvelopeEncryption) {}

  async seal(workspaceId: string, secret: ChatwootSealedCredentials): Promise<string> {
    if (!this.encryption.isConfigured) {
      throw new ServiceUnavailableException(ENCRYPTION_NOT_CONFIGURED);
    }
    return this.encryption.encrypt(
      { workspaceId, context: CHATWOOT_CREDENTIALS_CONTEXT },
      JSON.stringify(secret),
    );
  }

  async open(workspaceId: string, sealed: string): Promise<ChatwootSealedCredentials> {
    if (!this.encryption.isConfigured) {
      throw new ServiceUnavailableException(ENCRYPTION_NOT_CONFIGURED);
    }
    const raw = await this.encryption.decrypt(
      { workspaceId, context: CHATWOOT_CREDENTIALS_CONTEXT },
      sealed,
    );
    const parsed = JSON.parse(raw) as Partial<ChatwootSealedCredentials>;
    if (typeof parsed.apiAccessToken !== 'string' || parsed.apiAccessToken.length === 0) {
      throw new Error('Stored Chatwoot credentials are invalid or incomplete.');
    }
    return {
      apiAccessToken: parsed.apiAccessToken,
      agentBotToken: parsed.agentBotToken ?? null,
      webhookSecret: parsed.webhookSecret ?? null,
    };
  }
}
