import { Injectable, Logger } from '@nestjs/common';

const REQUEST_TIMEOUT_MS = 20_000;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;

/**
 * Coded Chatwoot API error whose message is safe for logs and UI feedback (never embeds tokens
 * or raw response bodies). Implements the `code` contract recognized by `describeError()`.
 */
export class ChatwootApiError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'ChatwootApiError';
    this.code = code;
    this.status = status;
  }
}

export interface ChatwootAccountSummary {
  id: number;
  name: string;
}

export interface ChatwootInboxSummary {
  id: number;
  name: string;
  channelType: string;
}

export interface ChatwootAgentBotSummary {
  id: number;
  name: string;
  outgoingUrl: string | null;
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
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ChatwootApiError('CHATWOOT_INVALID_URL', 'Enter a valid Chatwoot instance URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ChatwootApiError('CHATWOOT_INVALID_URL', 'Chatwoot URL must use http or https.');
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

  async listAgentBots(
    baseUrl: string,
    accountId: number,
    apiAccessToken: string,
    fetchImpl: typeof fetch = fetch,
  ): Promise<ChatwootAgentBotSummary[]> {
    const cleanBase = normalizeChatwootBaseUrl(baseUrl);
    const data = await this.request<
      | Array<{ id?: number; name?: string; outgoing_url?: string | null }>
      | { payload?: Array<{ id?: number; name?: string; outgoing_url?: string | null }> }
    >(`${cleanBase}/api/v1/accounts/${accountId}/agent_bots`, {
      method: 'GET',
      token: apiAccessToken,
      fetchImpl,
    });
    const list = Array.isArray(data) ? data : (data.payload ?? []);
    return list
      .filter((item): item is { id: number; name?: string; outgoing_url?: string | null } => {
        return typeof item.id === 'number';
      })
      .map((item) => ({
        id: item.id,
        name: item.name?.trim() || `AgentBot ${item.id}`,
        outgoingUrl: item.outgoing_url?.trim() || null,
      }));
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
    // Send RFC-compliant hyphenated header first so reverse proxies (Cloudflare, Nginx default)
    // do not drop underscore headers; Rails/Rack maps `api-access-token` to `HTTP_API_ACCESS_TOKEN`.
    // Fall back once to `api_access_token` on 401 for direct/custom servers expecting underscores.
    let response = await this.sendOnce(url, 'api-access-token', options);
    if (response.status === HTTP_UNAUTHORIZED) {
      response = await this.sendOnce(url, 'api_access_token', options);
    }
    if (!response.ok) {
      this.logger.warn(`Chatwoot API ${options.method} failed with HTTP ${response.status}`);
      throw this.toHttpError(response.status);
    }
    try {
      return (await response.json()) as Result;
    } catch {
      throw new ChatwootApiError(
        'CHATWOOT_INVALID_RESPONSE',
        'Chatwoot returned a non-JSON response. Verify the instance URL.',
        response.status,
      );
    }
  }

  private async sendOnce(
    url: string,
    tokenHeader: 'api-access-token' | 'api_access_token',
    options: {
      method: 'GET' | 'POST';
      token: string;
      body?: Record<string, unknown>;
      fetchImpl: typeof fetch;
    },
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await options.fetchImpl(url, {
        method: options.method,
        headers: {
          [tokenHeader]: options.token,
          ...(options.body ? { 'content-type': 'application/json' } : {}),
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ChatwootApiError(
          'CHATWOOT_TIMEOUT',
          'Chatwoot did not respond before the request timed out.',
        );
      }
      throw new ChatwootApiError(
        'CHATWOOT_NETWORK_ERROR',
        'Unable to reach the Chatwoot instance. Verify the URL and TLS certificate.',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private toHttpError(status: number): ChatwootApiError {
    if (status === HTTP_UNAUTHORIZED) {
      return new ChatwootApiError(
        'CHATWOOT_UNAUTHORIZED',
        'Chatwoot rejected the API access token (HTTP 401). Verify the user access token.',
        status,
      );
    }
    if (status === HTTP_FORBIDDEN) {
      return new ChatwootApiError(
        'CHATWOOT_FORBIDDEN',
        'The Chatwoot token does not have permission for this account or resource (HTTP 403).',
        status,
      );
    }
    if (status === HTTP_NOT_FOUND) {
      return new ChatwootApiError(
        'CHATWOOT_NOT_FOUND',
        'Chatwoot endpoint or account was not found (HTTP 404). Verify the instance URL and account.',
        status,
      );
    }
    return new ChatwootApiError(
      `CHATWOOT_HTTP_${status}`,
      `Chatwoot API returned HTTP ${status}.`,
      status,
    );
  }
}
