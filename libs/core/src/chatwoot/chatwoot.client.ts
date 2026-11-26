import { Injectable, Logger } from '@nestjs/common';

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_ERROR_CHARS = 300;

export interface ChatwootAccountSummary {
  id: number;
  name: string;
}

export interface ChatwootInboxSummary {
  id: number;
  name: string;
  channelType: string;
}

export interface ChatwootConversationState {
  id: number;
  status: string;
  inboxId: number | null;
  assigneeId: number | null;
}

export interface ChatwootProfileResult {
  accounts: ChatwootAccountSummary[];
}

export function normalizeChatwootBaseUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, '');
  const parsed = new URL(trimmed);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Chatwoot URL must use http or https.');
  }
  return parsed.origin + parsed.pathname.replace(/\/+$/, '');
}

/**
 * Official Chatwoot REST API client (self-hosted and compatible instances).
 * Separates administrative `apiAccessToken` (profile, accounts, inboxes) from operational
 * `agentBotToken` (daily message replies and handoff status toggles when configured).
 */
@Injectable()
export class ChatwootClient {
  private readonly logger = new Logger(ChatwootClient.name);

  async readProfile(
    baseUrl: string,
    apiAccessToken: string,
    fetchImpl: typeof fetch = fetch,
  ): Promise<ChatwootProfileResult> {
    const cleanBase = normalizeChatwootBaseUrl(baseUrl);
    const data = await this.request<{
      accounts?: Array<{ id?: number; name?: string }>;
    }>(`${cleanBase}/api/v1/profile`, { method: 'GET', token: apiAccessToken, fetchImpl });
    const accounts: ChatwootAccountSummary[] = (data.accounts ?? [])
      .filter((acc): acc is { id: number; name?: string } => typeof acc.id === 'number')
      .map((acc) => ({ id: acc.id, name: acc.name?.trim() || `Account ${acc.id}` }));
    return { accounts };
  }

  async listInboxes(
    baseUrl: string,
    accountId: number,
    apiAccessToken: string,
    fetchImpl: typeof fetch = fetch,
  ): Promise<ChatwootInboxSummary[]> {
    const cleanBase = normalizeChatwootBaseUrl(baseUrl);
    const data = await this.request<{
      payload?: Array<{ id?: number; name?: string; channel_type?: string }>;
    }>(`${cleanBase}/api/v1/accounts/${accountId}/inboxes`, {
      method: 'GET',
      token: apiAccessToken,
      fetchImpl,
    });
    return (data.payload ?? [])
      .filter((item): item is { id: number; name?: string; channel_type?: string } => {
        return typeof item.id === 'number';
      })
      .map((item) => ({
        id: item.id,
        name: item.name?.trim() || `Inbox ${item.id}`,
        channelType: item.channel_type?.trim() || 'Channel::WebWidget',
      }));
  }

  async getConversation(
    params: {
      baseUrl: string;
      accountId: number;
      conversationId: number;
      token: string;
    },
    fetchImpl: typeof fetch = fetch,
  ): Promise<ChatwootConversationState> {
    const cleanBase = normalizeChatwootBaseUrl(params.baseUrl);
    const data = await this.request<{
      id?: number;
      status?: string;
      inbox_id?: number;
      meta?: { assignee?: { id?: number } | null };
    }>(`${cleanBase}/api/v1/accounts/${params.accountId}/conversations/${params.conversationId}`, {
      method: 'GET',
      token: params.token,
      fetchImpl,
    });
    return {
      id: data.id ?? params.conversationId,
      status: data.status ?? 'open',
      inboxId: typeof data.inbox_id === 'number' ? data.inbox_id : null,
      assigneeId: typeof data.meta?.assignee?.id === 'number' ? data.meta.assignee.id : null,
    };
  }

  async sendMessage(
    params: {
      baseUrl: string;
      accountId: number;
      conversationId: number;
      token: string;
      content: string;
      isPrivate: boolean;
    },
    fetchImpl: typeof fetch = fetch,
  ): Promise<{ id: number | null }> {
    const cleanBase = normalizeChatwootBaseUrl(params.baseUrl);
    const data = await this.request<{ id?: number }>(
      `${cleanBase}/api/v1/accounts/${params.accountId}/conversations/${params.conversationId}/messages`,
      {
        method: 'POST',
        token: params.token,
        body: {
          content: params.content,
          message_type: 'outgoing',
          private: params.isPrivate,
        },
        fetchImpl,
      },
    );
    return { id: typeof data.id === 'number' ? data.id : null };
  }

  async toggleConversationStatus(
    params: {
      baseUrl: string;
      accountId: number;
      conversationId: number;
      token: string;
      status: 'open' | 'pending' | 'resolved';
    },
    fetchImpl: typeof fetch = fetch,
  ): Promise<void> {
    const cleanBase = normalizeChatwootBaseUrl(params.baseUrl);
    await this.request(
      `${cleanBase}/api/v1/accounts/${params.accountId}/conversations/${params.conversationId}/toggle_status`,
      {
        method: 'POST',
        token: params.token,
        body: { status: params.status },
        fetchImpl,
      },
    );
  }

  private async request<Result>(
    url: string,
    options: {
      method: 'GET' | 'POST';
      token: string;
      body?: Record<string, unknown>;
      fetchImpl: typeof fetch;
    },
  ): Promise<Result> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await options.fetchImpl(url, {
        method: options.method,
        headers: {
          api_access_token: options.token,
          ...(options.body ? { 'content-type': 'application/json' } : {}),
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = (await response.text().catch(() => '')).slice(0, MAX_ERROR_CHARS);
        this.logger.warn(`Chatwoot API ${options.method} failed with HTTP ${response.status}`);
        throw new Error(`Chatwoot responded HTTP ${response.status}${text ? `: ${text}` : ''}`);
      }
      return (await response.json()) as Result;
    } finally {
      clearTimeout(timer);
    }
  }
}
