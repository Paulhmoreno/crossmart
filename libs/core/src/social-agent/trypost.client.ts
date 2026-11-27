import { BadRequestException, Injectable, Logger } from '@nestjs/common';

export const DEFAULT_TRYPOST_API_URL = 'https://app.trypost.it/api';
const REQUEST_TIMEOUT_MS = 15_000;
const ERROR_PREVIEW_LEN = 240;

export interface TryPostAuth {
  baseUrl: string;
  apiKey: string;
}

export interface TryPostChannel {
  id: string;
  name: string;
  platform: string;
  username?: string | null;
  avatarUrl?: string | null;
  status?: string;
}

export interface TryPostCapabilities {
  restApi: boolean;
  channels: boolean;
  posts: boolean;
  ideas: boolean;
  mediaUpload: boolean;
  queueSlots: boolean;
  analytics: boolean;
  webhooks: boolean;
  notes: boolean;
  mcpSupported: boolean;
}

export interface TryPostTestResult {
  ok: boolean;
  error: string | null;
  channels: TryPostChannel[];
  capabilities: TryPostCapabilities;
  workspaceName: string | null;
}

export interface TryPostDraftInput {
  content: string;
  channelIds: string[];
  mediaTokens?: string[];
  scheduledAt?: string | null;
  /** Must remain 'draft' unless Crossmart explicitly verified human approval. */
  status: 'draft' | 'scheduled';
  internalNote?: string;
}

export function normalizeTryPostBaseUrl(rawUrl?: string | null): {
  baseUrl: string;
  isSelfHosted: boolean;
} {
  const trimmed = (rawUrl ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) {
    return { baseUrl: DEFAULT_TRYPOST_API_URL, isSelfHosted: false };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new BadRequestException('Invalid TryPost URL format.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new BadRequestException('TryPost URL must use https:// or http://.');
  }
  const host = parsed.hostname.toLowerCase();
  if (host === '169.254.169.254' || host === 'metadata.google.internal') {
    throw new BadRequestException('Disallowed metadata host for TryPost URL.');
  }
  const withApi = parsed.pathname.endsWith('/api')
    ? parsed.toString().replace(/\/+$/, '')
    : `${parsed.toString().replace(/\/+$/, '')}/api`;
  const isSelfHosted = host !== 'app.trypost.it' && host !== 'trypost.it';
  return { baseUrl: withApi, isSelfHosted };
}

function asArray(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) return raw as Array<Record<string, unknown>>;
  if (raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).data)) {
    return (raw as Record<string, unknown>).data as Array<Record<string, unknown>>;
  }
  return [];
}

function str(val: unknown, fallback = ''): string {
  return typeof val === 'string' || typeof val === 'number' ? String(val) : fallback;
}

/**
 * Official TryPost REST API client (`https://docs.trypost.it/api-reference/introduction`).
 * Supports TryPost Cloud and self-hosted instances. Never calls `/publish` without an explicit
 * Crossmart-verified approval gate in the calling service.
 */
@Injectable()
export class TryPostClient {
  private readonly logger = new Logger(TryPostClient.name);

  async testConnection(auth: TryPostAuth): Promise<TryPostTestResult> {
    try {
      const channelsRaw = await this.request<unknown>(auth, 'GET', '/channels');
      const channels: TryPostChannel[] = asArray(channelsRaw).map((ch) => ({
        id: str(ch.id),
        name: str(ch.name ?? ch.title ?? ch.username, 'Account'),
        platform: str(ch.platform ?? ch.provider ?? ch.type, 'social'),
        username: typeof ch.username === 'string' ? ch.username : null,
        avatarUrl: typeof ch.avatar_url === 'string' ? ch.avatar_url : null,
        status: str(ch.status, 'connected'),
      }));

      // Probe optional endpoints safely (read-only) to report real capabilities
      const [ideasOk, analyticsOk, webhooksOk] = await Promise.all([
        this.probeReadEndpoint(auth, '/ideas'),
        this.probeReadEndpoint(auth, '/analytics/workspace'),
        this.probeReadEndpoint(auth, '/webhooks'),
      ]);

      return {
        ok: true,
        error: null,
        channels,
        workspaceName: null,
        capabilities: {
          restApi: true,
          channels: true,
          posts: true,
          ideas: ideasOk,
          mediaUpload: true,
          queueSlots: channels.length > 0,
          analytics: analyticsOk,
          webhooks: webhooksOk,
          notes: true,
          mcpSupported: true,
        },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.debug(`TryPost testConnection failed: ${msg}`);
      return {
        ok: false,
        error: msg,
        channels: [],
        workspaceName: null,
        capabilities: {
          restApi: false,
          channels: false,
          posts: false,
          ideas: false,
          mediaUpload: false,
          queueSlots: false,
          analytics: false,
          webhooks: false,
          notes: false,
          mcpSupported: false,
        },
      };
    }
  }

  async listPosts(auth: TryPostAuth): Promise<Array<Record<string, unknown>>> {
    return asArray(await this.request<unknown>(auth, 'GET', '/posts'));
  }

  async listIdeas(auth: TryPostAuth): Promise<Array<Record<string, unknown>>> {
    return asArray(await this.request<unknown>(auth, 'GET', '/ideas'));
  }

  async createIdea(
    auth: TryPostAuth,
    input: { title: string; content: string; tags?: string[] },
  ): Promise<{ id: string; raw: Record<string, unknown> }> {
    const res = await this.request<Record<string, unknown>>(auth, 'POST', '/ideas', input);
    const data = (res.data as Record<string, unknown> | undefined) ?? res;
    return { id: str(data.id), raw: data };
  }

  async createPost(
    auth: TryPostAuth,
    input: TryPostDraftInput,
  ): Promise<{ id: string; status: string; raw: Record<string, unknown> }> {
    const payload: Record<string, unknown> = {
      content: input.content,
      channel_ids: input.channelIds,
      status: input.status,
      ...(input.mediaTokens?.length ? { media_tokens: input.mediaTokens } : {}),
      ...(input.status === 'scheduled' && input.scheduledAt
        ? { scheduled_at: input.scheduledAt }
        : {}),
    };
    const res = await this.request<Record<string, unknown>>(auth, 'POST', '/posts', payload);
    const data = (res.data as Record<string, unknown> | undefined) ?? res;
    const postId = str(data.id);

    if (postId && input.internalNote) {
      await this.request<unknown>(auth, 'POST', `/posts/${postId}/notes`, {
        body: input.internalNote,
      }).catch(() => undefined);
    }

    return { id: postId, status: str(data.status, input.status), raw: data };
  }

  async getQueueSlots(auth: TryPostAuth, channelId: string): Promise<Array<Record<string, unknown>>> {
    return asArray(await this.request<unknown>(auth, 'GET', `/channels/${channelId}/queue/slots`));
  }

  async getWorkspaceAnalytics(auth: TryPostAuth): Promise<Record<string, unknown> | null> {
    try {
      return await this.request<Record<string, unknown>>(auth, 'GET', '/analytics/workspace');
    } catch {
      return null;
    }
  }

  private async probeReadEndpoint(auth: TryPostAuth, path: string): Promise<boolean> {
    try {
      await this.request<unknown>(auth, 'GET', path);
      return true;
    } catch {
      return false;
    }
  }

  private async request<T>(
    auth: TryPostAuth,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${auth.baseUrl.replace(/\/+$/, '')}${path}`;
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${auth.apiKey}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const text = await response.text();
    let parsed: unknown = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { message: text.slice(0, ERROR_PREVIEW_LEN) };
    }
    if (!response.ok) {
      const msg =
        parsed && typeof parsed === 'object' && 'message' in parsed
          ? str((parsed as Record<string, unknown>).message)
          : `HTTP ${response.status}`;
      throw new Error(`TryPost API error (${response.status}): ${msg}`);
    }
    return parsed as T;
  }
}
