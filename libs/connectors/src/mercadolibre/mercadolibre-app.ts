import type { OAuthAppCredentials } from '@crossmart/common';
import { ChannelErrorCode } from '../sdk/errors/channel-error-code.enum.js';
import { mercadoLibreError } from './mercadolibre-errors.js';

const NOT_CONFIGURED = 'Mercado Libre is not configured on this Crossmart instance';

export type MercadoLibreAppSource = 'database' | 'env' | 'none';

export type MercadoLibreAppLoader = () => Promise<OAuthAppCredentials | null>;

/**
 * The Crossmart Mercado Libre app this instance uses: its App ID (the OAuth client id) and
 * Secret Key, which is never logged.
 *
 * Precedence:
 * 1. Encrypted persistent credentials stored in PostgreSQL (self-hosted admin UI).
 * 2. Environment variables `MERCADOLIBRE_CLIENT_ID` / `MERCADOLIBRE_CLIENT_SECRET` (upstream).
 */
export class MercadoLibreApp {
  private stored: OAuthAppCredentials | null = null;
  private loader: MercadoLibreAppLoader | null = null;

  constructor(private readonly envFallback: OAuthAppCredentials | null) {}

  /** Registers an async persistent store loader shared by API and worker processes. */
  setLoader(loader: MercadoLibreAppLoader): void {
    this.loader = loader;
  }

  /** Updates the in-memory stored credentials immediately after saving or clearing. */
  setStored(credentials: OAuthAppCredentials | null): void {
    this.stored = credentials;
  }

  /** Reloads stored credentials from PostgreSQL so API and worker stay in sync without restarts. */
  async reload(): Promise<void> {
    if (!this.loader) return;
    this.stored = await this.loader();
  }

  private get effective(): OAuthAppCredentials | null {
    return this.stored ?? this.envFallback;
  }

  get source(): MercadoLibreAppSource {
    if (this.stored) return 'database';
    if (this.envFallback) return 'env';
    return 'none';
  }

  get isConfigured(): boolean {
    return this.effective !== null;
  }

  settings(): OAuthAppCredentials {
    const current = this.effective;
    if (!current) {
      throw mercadoLibreError(ChannelErrorCode.ChannelUnavailable, NOT_CONFIGURED);
    }
    return current;
  }

  /** The App ID, which notifications carry as `application_id`; null without an app. */
  get appId(): string | null {
    return this.effective?.clientId ?? null;
  }
}
