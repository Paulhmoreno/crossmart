import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { EnvelopeEncryption } from '@crossmart/common';
import type { AiSealedSecret } from '../entities/ai-config.js';

const AI_CREDENTIALS_CONTEXT = 'workspace-ai-config';
const ENCRYPTION_NOT_CONFIGURED =
  'Credentials encryption is not configured on the server (set CREDENTIALS_MASTER_KEY).';

/**
 * Encrypts and decrypts workspace AI provider API keys using Crossmart's native per-workspace
 * AES-256-GCM envelope encryption (`WorkspaceDataKey` wrapped by `CREDENTIALS_MASTER_KEY`).
 */
@Injectable()
export class AiCredentialsVault {
  constructor(private readonly encryption: EnvelopeEncryption) {}

  get isConfigured(): boolean {
    return this.encryption.isConfigured;
  }

  async seal(workspaceId: string, secret: AiSealedSecret): Promise<string> {
    if (!this.encryption.isConfigured) {
      throw new ServiceUnavailableException(ENCRYPTION_NOT_CONFIGURED);
    }
    return this.encryption.encrypt(
      { workspaceId, context: AI_CREDENTIALS_CONTEXT },
      JSON.stringify(secret),
    );
  }

  async open(workspaceId: string, sealed: string): Promise<AiSealedSecret> {
    if (!this.encryption.isConfigured) {
      throw new ServiceUnavailableException(ENCRYPTION_NOT_CONFIGURED);
    }
    const raw = await this.encryption.decrypt(
      { workspaceId, context: AI_CREDENTIALS_CONTEXT },
      sealed,
    );
    const parsed = JSON.parse(raw) as Partial<AiSealedSecret>;
    if (typeof parsed.apiKey !== 'string' || parsed.apiKey.length === 0) {
      throw new Error('Stored AI credentials are invalid or incomplete');
    }
    return { apiKey: parsed.apiKey };
  }
}
