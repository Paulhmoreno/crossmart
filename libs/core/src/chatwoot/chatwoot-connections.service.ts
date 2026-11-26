import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AppConfigService, describeError } from '@crossmart/common';
import {
  type ChatwootConnection,
  ChatwootConnectionStatus,
  type Prisma,
  PrismaService,
} from '@crossmart/database';
import type { Actor } from '../activity/entities/actor.js';
import { ActivityAction } from '../activity/enums/activity-action.enum.js';
import { ActivitySubjectType } from '../activity/enums/activity-subject-type.enum.js';
import { ActivityRecorder } from '../activity/services/activity-recorder.js';
import {
  type ChatwootAccountSummary,
  ChatwootClient,
  type ChatwootInboxSummary,
  normalizeChatwootBaseUrl,
} from './chatwoot.client.js';
import {
  ChatwootCredentialsVault,
  type ChatwootSealedCredentials,
} from './chatwoot-credentials.vault.js';

const MAX_ERROR_LENGTH = 400;

export interface ChatwootConnectionView {
  id: string;
  name: string;
  baseUrl: string;
  accountId: number | null;
  accountName: string | null;
  inboxes: ChatwootInboxSummary[];
  hasApiAccessToken: boolean;
  hasAgentBotToken: boolean;
  hasWebhookSecret: boolean;
  agentBotReady: boolean;
  webhookAuthReady: boolean;
  operationalReady: boolean;
  webhookUrl: string;
  status: ChatwootConnectionStatus;
  lastError: string | null;
  lastTestedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SaveChatwootConnectionInput {
  name: string;
  baseUrl: string;
  accountId?: number | null;
  apiAccessToken?: string | null;
  agentBotToken?: string | null;
  webhookSecret?: string | null;
  enabled?: boolean;
}

export interface TestChatwootConnectionInput {
  connectionId?: string | null;
  baseUrl: string;
  accountId?: number | null;
  apiAccessToken?: string | null;
}

export interface TestChatwootConnectionResult {
  ok: boolean;
  accounts: ChatwootAccountSummary[];
  selectedAccountId: number | null;
  inboxes: ChatwootInboxSummary[];
  error: string | null;
}

function parseInboxes(raw: Prisma.JsonValue | null | undefined): ChatwootInboxSummary[] {
  if (!Array.isArray(raw)) return [];
  const results: ChatwootInboxSummary[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const obj = entry as Record<string, unknown>;
    if (typeof obj.id !== 'number') continue;
    results.push({
      id: obj.id,
      name: typeof obj.name === 'string' ? obj.name : `Inbox ${String(obj.id)}`,
      channelType: typeof obj.channelType === 'string' ? obj.channelType : 'Channel::WebWidget',
    });
  }
  return results;
}

/**
 * Manages encrypted Chatwoot connections per workspace: instance URL, administrative vs bot
 * credentials, account/inbox discovery, and webhook URL exposure.
 */
@Injectable()
export class ChatwootConnectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vault: ChatwootCredentialsVault,
    private readonly client: ChatwootClient,
    private readonly config: AppConfigService,
    private readonly activity: ActivityRecorder,
  ) {}

  async list(workspaceId: string): Promise<ChatwootConnectionView[]> {
    const rows = await this.prisma.chatwootConnection.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
    });
    return Promise.all(rows.map((row) => this.toView(workspaceId, row)));
  }

  async testConnection(
    workspaceId: string,
    input: TestChatwootConnectionInput,
  ): Promise<TestChatwootConnectionResult> {
    try {
      const baseUrl = normalizeChatwootBaseUrl(input.baseUrl);
      const token = await this.resolveAdminToken(
        workspaceId,
        input.connectionId,
        baseUrl,
        input.apiAccessToken,
      );
      const profile = await this.client.readProfile(baseUrl, token);
      const selectedAccount = this.resolveAccount(profile.accounts, input.accountId, false);
      const inboxes = selectedAccount
        ? await this.client.listInboxes(baseUrl, selectedAccount.id, token)
        : [];
      return {
        ok: true,
        accounts: profile.accounts,
        selectedAccountId: selectedAccount?.id ?? null,
        inboxes,
        error: null,
      };
    } catch (error) {
      return {
        ok: false,
        accounts: [],
        selectedAccountId: null,
        inboxes: [],
        error: this.formatUserError(error),
      };
    }
  }

  async create(
    workspaceId: string,
    input: SaveChatwootConnectionInput,
    actor: Actor,
  ): Promise<ChatwootConnectionView> {
    const baseUrl = normalizeChatwootBaseUrl(input.baseUrl);
    const apiAccessToken = input.apiAccessToken?.trim() ?? '';
    if (!apiAccessToken) throw new BadRequestException('Chatwoot API access token is required.');

    const verified = await this.verifyAndDiscover(baseUrl, apiAccessToken, input.accountId);
    const sealed = await this.vault.seal(workspaceId, {
      apiAccessToken,
      agentBotToken: input.agentBotToken?.trim() || null,
      webhookSecret: input.webhookSecret?.trim() || null,
    });
    const created = await this.prisma.chatwootConnection.create({
      data: {
        workspaceId,
        name: input.name.trim() || verified.account.name || 'Chatwoot',
        baseUrl,
        accountId: verified.account.id,
        accountName: verified.account.name,
        sealedCredentials: sealed,
        inboxes: verified.inboxes as unknown as Prisma.InputJsonValue,
        status:
          input.enabled === false
            ? ChatwootConnectionStatus.DISABLED
            : ChatwootConnectionStatus.CONNECTED,
        lastError: null,
        lastTestedAt: new Date(),
        updatedById: actor.userId,
      },
    });
    await this.activity.record(workspaceId, actor, {
      action: ActivityAction.ChannelConnected,
      subject: { type: ActivitySubjectType.Workspace, id: workspaceId, label: created.name },
      detail: created.baseUrl,
    });
    return this.toView(workspaceId, created);
  }

  async update(
    workspaceId: string,
    connectionId: string,
    input: SaveChatwootConnectionInput,
    actor: Actor,
  ): Promise<ChatwootConnectionView> {
    const existing = await this.requireConnection(workspaceId, connectionId);
    const currentCreds = await this.vault.open(workspaceId, existing.sealedCredentials);
    const baseUrl = normalizeChatwootBaseUrl(input.baseUrl);
    const suppliedToken = input.apiAccessToken?.trim() ?? '';
    if (baseUrl !== existing.baseUrl && !suppliedToken) {
      throw new BadRequestException(
        'Enter the Chatwoot API access token when changing the instance URL.',
      );
    }
    const nextCreds: ChatwootSealedCredentials = {
      apiAccessToken: suppliedToken || currentCreds.apiAccessToken,
      agentBotToken:
        input.agentBotToken !== undefined && input.agentBotToken !== null
          ? input.agentBotToken.trim() || currentCreds.agentBotToken
          : currentCreds.agentBotToken,
      webhookSecret:
        input.webhookSecret !== undefined && input.webhookSecret !== null
          ? input.webhookSecret.trim() || currentCreds.webhookSecret
          : currentCreds.webhookSecret,
    };
    const requestedAccountId =
      input.accountId !== undefined
        ? input.accountId
        : baseUrl === existing.baseUrl
          ? existing.accountId
          : null;

    const verified = await this.verifyAndDiscover(
      baseUrl,
      nextCreds.apiAccessToken,
      requestedAccountId,
    );
    const sealed = await this.vault.seal(workspaceId, nextCreds);
    const updated = await this.prisma.chatwootConnection.update({
      where: { id: connectionId },
      data: {
        name: input.name.trim() || existing.name,
        baseUrl,
        accountId: verified.account.id,
        accountName: verified.account.name,
        sealedCredentials: sealed,
        inboxes: verified.inboxes as unknown as Prisma.InputJsonValue,
        status:
          input.enabled === false
            ? ChatwootConnectionStatus.DISABLED
            : ChatwootConnectionStatus.CONNECTED,
        lastError: null,
        lastTestedAt: new Date(),
        updatedById: actor.userId,
      },
    });
    return this.toView(workspaceId, updated);
  }

  async refreshInboxes(workspaceId: string, connectionId: string): Promise<ChatwootConnectionView> {
    const existing = await this.requireConnection(workspaceId, connectionId);
    const creds = await this.vault.open(workspaceId, existing.sealedCredentials);
    try {
      const verified = await this.verifyAndDiscover(
        existing.baseUrl,
        creds.apiAccessToken,
        existing.accountId,
      );
      const updated = await this.prisma.chatwootConnection.update({
        where: { id: connectionId },
        data: {
          accountId: verified.account.id,
          accountName: verified.account.name,
          inboxes: verified.inboxes as unknown as Prisma.InputJsonValue,
          status:
            existing.status === ChatwootConnectionStatus.DISABLED
              ? ChatwootConnectionStatus.DISABLED
              : ChatwootConnectionStatus.CONNECTED,
          lastError: null,
          lastTestedAt: new Date(),
        },
      });
      return this.toView(workspaceId, updated);
    } catch (error) {
      const message = this.formatUserError(error);
      await this.prisma.chatwootConnection.update({
        where: { id: connectionId },
        data: {
          status: ChatwootConnectionStatus.ERROR,
          lastError: message,
          lastTestedAt: new Date(),
        },
      });
      throw new BadRequestException(message);
    }
  }

  async delete(workspaceId: string, connectionId: string): Promise<void> {
    await this.requireConnection(workspaceId, connectionId);
    await this.prisma.chatwootConnection.delete({ where: { id: connectionId } });
  }

  async openOperationalConnection(connectionId: string): Promise<{
    connection: ChatwootConnection;
    credentials: ChatwootSealedCredentials;
  }> {
    const connection = await this.prisma.chatwootConnection.findUnique({
      where: { id: connectionId },
    });
    if (!connection) throw new NotFoundException('Chatwoot connection not found.');
    const credentials = await this.vault.open(connection.workspaceId, connection.sealedCredentials);
    return { connection, credentials };
  }

  private async verifyAndDiscover(
    baseUrl: string,
    token: string,
    preferredAccountId?: number | null,
  ): Promise<{
    account: ChatwootAccountSummary;
    inboxes: ChatwootInboxSummary[];
  }> {
    try {
      const profile = await this.client.readProfile(baseUrl, token);
      const account = this.resolveAccount(profile.accounts, preferredAccountId, true);
      if (!account) {
        throw new BadRequestException('Select a Chatwoot account to connect.');
      }
      const inboxes = await this.client.listInboxes(baseUrl, account.id, token);
      return { account, inboxes };
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException(this.formatUserError(error));
    }
  }

  private resolveAccount(
    accounts: ChatwootAccountSummary[],
    preferredAccountId: number | null | undefined,
    requireSelection: boolean,
  ): ChatwootAccountSummary | null {
    if (accounts.length === 0) {
      throw new BadRequestException('No Chatwoot accounts are authorized for this token.');
    }
    if (preferredAccountId !== null && preferredAccountId !== undefined) {
      const match = accounts.find((acc) => acc.id === preferredAccountId);
      if (!match) {
        throw new BadRequestException(
          `Chatwoot account ${preferredAccountId} is not authorized for this token.`,
        );
      }
      return match;
    }
    if (accounts.length === 1) return accounts[0] ?? null;
    if (requireSelection) {
      throw new BadRequestException(
        'Multiple Chatwoot accounts are available. Select the account to connect.',
      );
    }
    return null;
  }

  private formatUserError(error: unknown): string {
    if (error instanceof BadRequestException) {
      return error.message.slice(0, MAX_ERROR_LENGTH);
    }
    return describeError(error).slice(0, MAX_ERROR_LENGTH);
  }

  private async resolveAdminToken(
    workspaceId: string,
    connectionId: string | null | undefined,
    requestedBaseUrl: string,
    supplied: string | null | undefined,
  ): Promise<string> {
    const trimmed = supplied?.trim() ?? '';
    if (trimmed) return trimmed;
    if (connectionId) {
      const existing = await this.requireConnection(workspaceId, connectionId);
      if (existing.baseUrl !== requestedBaseUrl) {
        throw new BadRequestException(
          'Enter the Chatwoot API access token when testing a different instance URL.',
        );
      }
      const creds = await this.vault.open(workspaceId, existing.sealedCredentials);
      return creds.apiAccessToken;
    }
    throw new BadRequestException('Chatwoot API access token is required.');
  }

  private async requireConnection(
    workspaceId: string,
    connectionId: string,
  ): Promise<ChatwootConnection> {
    const row = await this.prisma.chatwootConnection.findFirst({
      where: { id: connectionId, workspaceId },
    });
    if (!row) throw new NotFoundException('Chatwoot connection not found.');
    return row;
  }

  private async toView(
    workspaceId: string,
    row: ChatwootConnection,
  ): Promise<ChatwootConnectionView> {
    let hasAgentBotToken = false;
    let hasWebhookSecret = false;
    try {
      const creds = await this.vault.open(workspaceId, row.sealedCredentials);
      hasAgentBotToken = Boolean(creds.agentBotToken);
      hasWebhookSecret = Boolean(creds.webhookSecret);
    } catch {
      // Keep flags false if decryption fails.
    }
    const baseApi = this.config.apiPublicUrl.replace(/\/+$/, '');
    const connected = row.status === ChatwootConnectionStatus.CONNECTED;
    return {
      id: row.id,
      name: row.name,
      baseUrl: row.baseUrl,
      accountId: row.accountId,
      accountName: row.accountName,
      inboxes: parseInboxes(row.inboxes),
      hasApiAccessToken: Boolean(row.sealedCredentials),
      hasAgentBotToken,
      hasWebhookSecret,
      agentBotReady: hasAgentBotToken,
      webhookAuthReady: hasWebhookSecret,
      operationalReady: connected && hasAgentBotToken && hasWebhookSecret,
      webhookUrl: `${baseApi}/api/v1/webhooks/chatwoot/${row.id}`,
      status: row.status,
      lastError: row.lastError,
      lastTestedAt: row.lastTestedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
