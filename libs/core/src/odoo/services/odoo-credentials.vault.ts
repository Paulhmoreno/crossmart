import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { EnvelopeEncryption } from '@crossmart/common';
import type { OdooSealedSecret } from '../entities/odoo-connection.js';
import { ODOO_CREDENTIALS_CONTEXT } from '../odoo.constants.js';

const ENCRYPTION_NOT_CONFIGURED =
  'Credentials encryption is not configured on the server (set CREDENTIALS_MASTER_KEY).';

/**
 * Encrypts and decrypts Odoo API keys using Crossmart's native per-workspace AES-256-GCM
 * envelope encryption (`WorkspaceDataKey` wrapped by `CREDENTIALS_MASTER_KEY`).
 */
@Injectable()
export class OdooCredentialsVault {
  constructor(private readonly encryption: EnvelopeEncryption) {}

  get isConfigured(): boolean {
    return this.encryption.isConfigured;
  }

  async seal(workspaceId: string, secret: OdooSealedSecret): Promise<string> {
    if (!this.encryption.isConfigured) {
      throw new ServiceUnavailableException(ENCRYPTION_NOT_CONFIGURED);
    }
    return this.encryption.encrypt(
      { workspaceId, context: ODOO_CREDENTIALS_CONTEXT },
      JSON.stringify(secret),
    );
  }

  async open(workspaceId: string, sealed: string): Promise<OdooSealedSecret> {
    if (!this.encryption.isConfigured) {
      throw new ServiceUnavailableException(ENCRYPTION_NOT_CONFIGURED);
    }
    const raw = await this.encryption.decrypt(
      { workspaceId, context: ODOO_CREDENTIALS_CONTEXT },
      sealed,
    );
    const parsed = JSON.parse(raw) as Partial<OdooSealedSecret>;
    if (typeof parsed.apiKey !== 'string' || parsed.apiKey.length === 0) {
      throw new Error('Stored Odoo credentials are invalid or incomplete');
    }
    return { apiKey: parsed.apiKey };
  }
}
