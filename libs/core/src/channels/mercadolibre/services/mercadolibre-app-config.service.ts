import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  type OnModuleInit,
} from '@nestjs/common';
import { AppConfigService, EnvelopeEncryption, type OAuthAppCredentials } from '@crossmart/common';
import { ChannelType, MercadoLibreApp, type MercadoLibreAppSource } from '@crossmart/connectors';
import { ChannelConnectionStatus, PrismaService } from '@crossmart/database';
import { CHANNEL_OAUTH_CALLBACK_PATH, CHANNEL_PATH_PARAM } from '../../channels.constants.js';

const APP_SECRET_CONTEXT = 'channel_app:mercado_libre';

export interface MercadoLibreAppConfigStatus {
  configured: boolean;
  source: MercadoLibreAppSource;
  clientId: string | null;
  hasClientSecret: boolean;
  redirectUri: string;
  activeConnections: number;
}

export interface SaveMercadoLibreAppConfigInput {
  clientId: string;
  clientSecret?: string;
}

/**
 * Persists and dynamically resolves Mercado Libre OAuth app credentials (`App ID` and encrypted
 * `Secret Key`) shared between API and worker processes without restarts.
 *
 * Precedence: stored PostgreSQL credentials (`database`) override `.env` fallback (`env`).
 */
@Injectable()
export class MercadoLibreAppConfigService implements OnModuleInit {
  private readonly logger = new Logger(MercadoLibreAppConfigService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EnvelopeEncryption,
    private readonly appConfig: AppConfigService,
    private readonly mercadoLibreApp: MercadoLibreApp,
  ) {}

  async onModuleInit(): Promise<void> {
    this.mercadoLibreApp.setLoader(() => this.loadStoredCredentials());
    try {
      await this.mercadoLibreApp.reload();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Could not hydrate Mercado Libre app credentials at startup: ${message}`);
    }
  }

  /** Effective OAuth Redirect URI configured on this instance. */
  redirectUri(): string {
    const path = CHANNEL_OAUTH_CALLBACK_PATH.replace(CHANNEL_PATH_PARAM, ChannelType.MercadoLibre);
    return new URL(path, this.appConfig.apiPublicUrl).toString();
  }

  /** Current configuration status without ever exposing the Secret Key. */
  async getStatus(): Promise<MercadoLibreAppConfigStatus> {
    await this.mercadoLibreApp.reload();
    const activeConnections = await this.countActiveConnections();
    return {
      configured: this.mercadoLibreApp.isConfigured,
      source: this.mercadoLibreApp.source,
      clientId: this.mercadoLibreApp.appId,
      hasClientSecret: this.mercadoLibreApp.isConfigured,
      redirectUri: this.redirectUri(),
      activeConnections,
    };
  }

  /**
   * Saves encrypted Mercado Libre OAuth app credentials. Blocks changing `clientId` while active
   * Mercado Libre connections exist so existing stores are never silently invalidated.
   */
  async save(
    workspaceId: string,
    input: SaveMercadoLibreAppConfigInput,
    updatedById: string,
  ): Promise<MercadoLibreAppConfigStatus> {
    await this.mercadoLibreApp.reload();
    const clientId = input.clientId.trim();
    if (!clientId) {
      throw new BadRequestException('App ID is required');
    }
    const existing = await this.prisma.channelAppConfig.findUnique({
      where: { channel: ChannelType.MercadoLibre },
    });
    const activeConnections = await this.countActiveConnections();
    const currentClientId = this.mercadoLibreApp.appId;
    if (activeConnections > 0 && currentClientId && currentClientId !== clientId) {
      throw new ConflictException(
        'Disconnect active Mercado Libre stores before changing the App ID.',
      );
    }

    const secretInput = input.clientSecret?.trim();
    const { sealedSecret, encryptionWorkspaceId, plainSecret } = await this.resolveSecret(
      workspaceId,
      secretInput,
      existing,
    );

    await this.prisma.channelAppConfig.upsert({
      where: { channel: ChannelType.MercadoLibre },
      create: {
        channel: ChannelType.MercadoLibre,
        clientId,
        sealedSecret,
        encryptionWorkspaceId,
        updatedById,
      },
      update: {
        clientId,
        sealedSecret,
        encryptionWorkspaceId,
        updatedById,
      },
    });

    this.mercadoLibreApp.setStored({ clientId, clientSecret: plainSecret });
    return this.getStatus();
  }

  private async resolveSecret(
    workspaceId: string,
    secretInput: string | undefined,
    existing: { sealedSecret: string; encryptionWorkspaceId: string } | null,
  ): Promise<{ sealedSecret: string; encryptionWorkspaceId: string; plainSecret: string }> {
    if (secretInput) {
      const sealedSecret = await this.encryption.encrypt(
        { workspaceId, context: APP_SECRET_CONTEXT },
        secretInput,
      );
      return { sealedSecret, encryptionWorkspaceId: workspaceId, plainSecret: secretInput };
    }
    if (existing) {
      const plainSecret = await this.encryption.decrypt(
        { workspaceId: existing.encryptionWorkspaceId, context: APP_SECRET_CONTEXT },
        existing.sealedSecret,
      );
      return {
        sealedSecret: existing.sealedSecret,
        encryptionWorkspaceId: existing.encryptionWorkspaceId,
        plainSecret,
      };
    }
    throw new BadRequestException('Secret Key is required');
  }

  private async loadStoredCredentials(): Promise<OAuthAppCredentials | null> {
    const record = await this.prisma.channelAppConfig.findUnique({
      where: { channel: ChannelType.MercadoLibre },
    });
    if (!record) return null;
    const clientSecret = await this.encryption.decrypt(
      { workspaceId: record.encryptionWorkspaceId, context: APP_SECRET_CONTEXT },
      record.sealedSecret,
    );
    return { clientId: record.clientId, clientSecret };
  }

  private countActiveConnections(): Promise<number> {
    return this.prisma.channelConnection.count({
      where: {
        channel: ChannelType.MercadoLibre,
        status: { not: ChannelConnectionStatus.DISCONNECTED },
      },
    });
  }
}
