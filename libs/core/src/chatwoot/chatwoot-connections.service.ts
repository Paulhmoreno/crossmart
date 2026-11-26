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
        input.apiAccessToken,
      );
      const profile = await this.client.readProfile(baseUrl, token);
      const selectedAccount =
        profile.accounts.find((acc) => acc.id === input.accountId) ?? profile.accounts[0] ?? null;
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
        error: describeError(error).slice(0, MAX_ERROR_LENGTH),
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
    const discovery = await this.discoverOptional(baseUrl, apiAccessToken, input.accountId);
    const sealed = await this.vault.seal(workspaceId, {
      apiAccessToken,
      agentBotToken: input.agentBotToken?.trim() || null,
      webhookSecret: input.webhookSecret?.trim() || null,
    });
    const created = await this.prisma.chatwootConnection.create({
      data: {
        workspaceId,
        name: input.name.trim() || 'Chatwoot',
        baseUrl,
        accountId: discovery.accountId,
        accountName: discovery.accountName,
        sealedCredentials: sealed,
        inboxes: discovery.inboxes as unknown as Prisma.InputJsonValue,
        status:
          input.enabled === false
            ? ChatwootConnectionStatus.DISABLED
            : discovery.error
              ? ChatwootConnectionStatus.ERROR
              : ChatwootConnectionStatus.CONNECTED,
        lastError: discovery.error,
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
    const nextCreds: ChatwootSealedCredentials = {
      apiAccessToken: input.apiAccessToken?.trim() || currentCreds.apiAccessToken,
      agentBotToken:
        input.agentBotToken !== undefined
          ? input.agentBotToken?.trim() || null
          : currentCreds.agentBotToken,
      webhookSecret:
        input.webhookSecret !== undefined
          ? input.webhookSecret?.trim() || null
          : currentCreds.webhookSecret,
    };
    const discovery = await this.discoverOptional(
      baseUrl,
      nextCreds.apiAccessToken,
      input.accountId ?? existing.accountId,
    );
    const sealed = await this.vault.seal(workspaceId, nextCreds);
    const updated = await this.prisma.chatwootConnection.update({
      where: { id: connectionId },
      data: {
        name: input.name.trim() || existing.name,
        baseUrl,
        accountId: discovery.accountId ?? existing.accountId,
        accountName: discovery.accountName ?? existing.accountName,
        sealedCredentials: sealed,
        inboxes:
          discovery.inboxes.length > 0
            ? (discovery.inboxes as unknown as Prisma.InputJsonValue)
            : (existing.inboxes as Prisma.InputJsonValue),
        status:
          input.enabled === false
            ? ChatwootConnectionStatus.DISABLED
            : discovery.error
              ? ChatwootConnectionStatus.ERROR
              : ChatwootConnectionStatus.CONNECTED,
        lastError: discovery.error,
        lastTestedAt: new Date(),
        updatedById: actor.userId,
      },
    });
    return this.toView(workspaceId, updated);
  }

  async refreshInboxes(workspaceId: string, connectionId: string): Promise<ChatwootConnectionView> {
    const existing = await this.requireConnection(workspaceId, connectionId);
    const creds = await this.vault.open(workspaceId, existing.sealedCredentials);
    const profile = await this.client.readProfile(existing.baseUrl, creds.apiAccessToken);
    const selected =
      profile.accounts.find((acc) => acc.id === existing.accountId) ?? profile.accounts[0] ?? null;
    const inboxes = selected
      ? await this.client.listInboxes(existing.baseUrl, selected.id, creds.apiAccessToken)
      : [];
    const updated = await this.prisma.chatwootConnection.update({
      where: { id: connectionId },
      data: {
        accountId: selected?.id ?? existing.accountId,
        accountName: selected?.name ?? existing.accountName,
        inboxes: inboxes as unknown as Prisma.InputJsonValue,
        status: ChatwootConnectionStatus.CONNECTED,
        lastError: null,
        lastTestedAt: new Date(),
      },
    });
    return this.toView(workspaceId, updated);
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

  private async discoverOptional(
    baseUrl: string,
    token: string,
    preferredAccountId?: number | null,
  ): Promise<{
    accountId: number | null;
    accountName: string | null;
    inboxes: ChatwootInboxSummary[];
    error: string | null;
  }> {
    try {
      const profile = await this.client.readProfile(baseUrl, token);
      const selected =
        profile.accounts.find((acc) => acc.id === preferredAccountId) ??
        profile.accounts[0] ??
        null;
      const inboxes = selected ? await this.client.listInboxes(baseUrl, selected.id, token) : [];
      return {
        accountId: selected?.id ?? preferredAccountId ?? null,
        accountName: selected?.name ?? null,
        inboxes,
        error: null,
      };
    } catch (error) {
      return {
        accountId: preferredAccountId ?? null,
        accountName: null,
        inboxes: [],
        error: describeError(error).slice(0, MAX_ERROR_LENGTH),
      };
    }
  }

  private async resolveAdminToken(
    workspaceId: string,
    connectionId: string | null | undefined,
    supplied: string | null | undefined,
  ): Promise<string> {
    const trimmed = supplied?.trim() ?? '';
    if (trimmed) return trimmed;
    if (connectionId) {
      const existing = await this.requireConnection(workspaceId, connectionId);
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
      webhookUrl: `${baseApi}/api/v1/webhooks/chatwoot/${row.id}`,
      status: row.status,
      lastError: row.lastError,
      lastTestedAt: row.lastTestedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
