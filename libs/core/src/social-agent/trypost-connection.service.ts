import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { type Prisma, PrismaService } from '@crossmart/database';
import type { Actor } from '../activity/entities/actor.js';
import { OdooCredentialsVault } from '../odoo/services/odoo-credentials.vault.js';
import {
  normalizeTryPostBaseUrl,
  TryPostClient,
  type TryPostAuth,
  type TryPostCapabilities,
  type TryPostChannel,
} from './trypost.client.js';

type TryPostRow = NonNullable<
  Awaited<ReturnType<PrismaService['tryPostConnection']['findUnique']>>
>;

const MASK_SUFFIX = 4;

export interface TryPostConnectionView {
  id: string;
  displayName: string;
  baseUrl: string;
  isSelfHosted: boolean;
  secretMasked: string | null;
  status: string;
  statusReason: string | null;
  remoteWorkspaceName: string | null;
  channels: TryPostChannel[];
  capabilities: Partial<TryPostCapabilities>;
  lastTestedAt: Date | null;
  lastSyncedAt: Date | null;
  updatedAt: Date;
}

export interface UpsertTryPostInput {
  displayName?: string;
  baseUrl?: string;
  apiKey?: string;
}

function maskKey(key: string): string {
  return key.length >= MASK_SUFFIX ? `••••••${key.slice(-MASK_SUFFIX)}` : '••••••';
}

function toView(row: TryPostRow): TryPostConnectionView {
  return {
    id: row.id,
    displayName: row.displayName,
    baseUrl: row.baseUrl,
    isSelfHosted: row.isSelfHosted,
    secretMasked: row.secretMasked,
    status: row.status,
    statusReason: row.statusReason,
    remoteWorkspaceName: row.remoteWorkspaceName,
    channels: Array.isArray(row.channels) ? (row.channels as unknown as TryPostChannel[]) : [],
    capabilities:
      row.capabilities && typeof row.capabilities === 'object' && !Array.isArray(row.capabilities)
        ? (row.capabilities as unknown as Partial<TryPostCapabilities>)
        : {},
    lastTestedAt: row.lastTestedAt,
    lastSyncedAt: row.lastSyncedAt,
    updatedAt: row.updatedAt,
  };
}

@Injectable()
export class TryPostConnectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly client: TryPostClient,
    private readonly vault: OdooCredentialsVault,
  ) {}

  async getStatus(workspaceId: string): Promise<TryPostConnectionView | null> {
    const row = await this.prisma.tryPostConnection.findUnique({ where: { workspaceId } });
    return row ? toView(row) : null;
  }

  async openAuth(workspaceId: string): Promise<TryPostAuth | null> {
    const row = await this.prisma.tryPostConnection.findUnique({ where: { workspaceId } });
    if (!row?.sealedCredentials || row.status === 'DISCONNECTED') return null;
    const opened = await this.vault.open(workspaceId, row.sealedCredentials);
    if (!opened.apiKey) return null;
    return { baseUrl: row.baseUrl, apiKey: opened.apiKey };
  }

  async testConnection(workspaceId: string, input: UpsertTryPostInput) {
    const existing = await this.prisma.tryPostConnection.findUnique({ where: { workspaceId } });
    const { baseUrl } = normalizeTryPostBaseUrl(input.baseUrl ?? existing?.baseUrl);
    let apiKey = input.apiKey?.trim() ?? '';
    if (!apiKey && existing?.sealedCredentials) {
      const opened = await this.vault.open(workspaceId, existing.sealedCredentials);
      apiKey = opened.apiKey ?? '';
    }
    if (!apiKey) {
      throw new BadRequestException('Enter a TryPost API key to test the connection.');
    }
    const result = await this.client.testConnection({ baseUrl, apiKey });
    if (existing) {
      await this.prisma.tryPostConnection.update({
        where: { id: existing.id },
        data: {
          lastTestedAt: new Date(),
          status: result.ok ? 'CONNECTED' : 'ERROR',
          statusReason: result.ok ? null : result.error,
          ...(result.ok
            ? {
                channels: result.channels as unknown as Prisma.InputJsonValue,
                capabilities: result.capabilities as unknown as Prisma.InputJsonValue,
              }
            : {}),
        },
      });
    }
    return result;
  }

  async upsertConnection(
    workspaceId: string,
    input: UpsertTryPostInput,
    _actor: Actor,
  ): Promise<TryPostConnectionView> {
    const existing = await this.prisma.tryPostConnection.findUnique({ where: { workspaceId } });
    const { baseUrl, isSelfHosted } = normalizeTryPostBaseUrl(input.baseUrl ?? existing?.baseUrl);

    let apiKey = input.apiKey?.trim() ?? '';
    if (!apiKey && existing?.sealedCredentials) {
      const opened = await this.vault.open(workspaceId, existing.sealedCredentials);
      apiKey = opened.apiKey ?? '';
    }
    if (!apiKey) {
      throw new BadRequestException('Enter a TryPost API key to connect.');
    }

    const test = await this.client.testConnection({ baseUrl, apiKey });
    if (!test.ok) {
      throw new BadRequestException(test.error ?? 'Could not authenticate with TryPost.');
    }

    const sealedCredentials = await this.vault.seal(workspaceId, { apiKey });
    const now = new Date();
    const data = {
      displayName: input.displayName?.trim() || 'TryPost',
      baseUrl,
      isSelfHosted,
      sealedCredentials,
      secretMasked: maskKey(apiKey),
      status: 'CONNECTED',
      statusReason: null,
      remoteWorkspaceName: test.workspaceName,
      channels: test.channels as unknown as Prisma.InputJsonValue,
      capabilities: test.capabilities as unknown as Prisma.InputJsonValue,
      lastTestedAt: now,
      lastSyncedAt: now,
    };

    const saved = existing
      ? await this.prisma.tryPostConnection.update({ where: { id: existing.id }, data })
      : await this.prisma.tryPostConnection.create({ data: { workspaceId, ...data } });

    await this.prisma.socialAgentEvent.create({
      data: {
        workspaceId,
        eventType: 'trypost_connected',
        summary: `TryPost conectado (${test.channels.length} cuenta(s) social(es) detectada(s)).`,
        severity: 'success',
        metadata: { channelCount: test.channels.length, isSelfHosted },
      },
    });

    return toView(saved);
  }

  async disconnect(workspaceId: string): Promise<TryPostConnectionView> {
    const existing = await this.prisma.tryPostConnection.findUnique({ where: { workspaceId } });
    if (!existing) throw new NotFoundException('TryPost connection not found.');

    const updated = await this.prisma.tryPostConnection.update({
      where: { id: existing.id },
      data: {
        status: 'DISCONNECTED',
        sealedCredentials: null,
        secretMasked: null,
        statusReason: null,
      },
    });

    await this.prisma.socialAgentEvent.create({
      data: {
        workspaceId,
        eventType: 'trypost_disconnected',
        summary: 'Credenciales de TryPost revocadas y conexión desconectada.',
        severity: 'warning',
      },
    });

    return toView(updated);
  }

  async fetchRemoteOverview(workspaceId: string) {
    const auth = await this.openAuth(workspaceId);
    if (!auth) {
      return { connected: false, ideas: [], posts: [], analytics: null };
    }
    const [ideas, posts, analytics] = await Promise.all([
      this.client.listIdeas(auth).catch(() => []),
      this.client.listPosts(auth).catch(() => []),
      this.client.getWorkspaceAnalytics(auth),
    ]);
    await this.prisma.tryPostConnection.update({
      where: { workspaceId },
      data: { lastSyncedAt: new Date() },
    });
    return {
      connected: true,
      ideas: ideas.slice(0, 20),
      posts: posts.slice(0, 20),
      analytics,
    };
  }
}
