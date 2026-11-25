import { describe, expect, it, vi } from 'vitest';
import { AiConfigStatus, type PrismaService } from '@crossmart/database';
import { Actor } from '../../activity/entities/actor.js';
import type { ActivityRecorder } from '../../activity/services/activity-recorder.js';
import { AiConfigSource } from '../entities/ai-config.js';
import { AiProviderName } from '../enums/ai-provider-name.enum.js';
import type { AnthropicClientFactory } from '../providers/anthropic/anthropic-client.factory.js';
import { FakeAiProvider } from '../testing/fake-ai.provider.js';
import { AiConfigService } from './ai-config.service.js';
import type { AiCredentialsVault } from './ai-credentials.vault.js';

function createService() {
  const rows = new Map<string, Record<string, unknown>>();
  const prisma = {
    workspaceAiConfig: {
      findUnique: vi.fn(({ where }: { where: { workspaceId: string } }) =>
        Promise.resolve(rows.get(where.workspaceId) ?? null),
      ),
      upsert: vi.fn(
        ({
          where,
          create,
          update,
        }: {
          where: { workspaceId: string };
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          const existing = rows.get(where.workspaceId);
          const next = existing
            ? { ...existing, ...update, updatedAt: new Date() }
            : {
                id: 'cfg-1',
                lastTestedAt: null,
                ...create,
                createdAt: new Date(),
                updatedAt: new Date(),
              };
          rows.set(where.workspaceId, next);
          return Promise.resolve(next);
        },
      ),
      deleteMany: vi.fn(({ where }: { where: { workspaceId: string } }) => {
        rows.delete(where.workspaceId);
        return Promise.resolve({ count: 1 });
      }),
      updateMany: vi.fn(() => Promise.resolve({ count: 1 })),
    },
  };
  const vault = {
    isConfigured: true,
    seal: vi.fn((_wsId: string, secret: { apiKey: string }) =>
      Promise.resolve(`sealed:${secret.apiKey}`),
    ),
    open: vi.fn((_wsId: string, sealed: string) =>
      Promise.resolve({ apiKey: sealed.replace(/^sealed:/, '') }),
    ),
  };
  const anthropicClients = { create: vi.fn() };
  const activity = { record: vi.fn(() => Promise.resolve()) };
  const defaultProvider = new FakeAiProvider(false);

  const service = new AiConfigService(
    prisma as unknown as PrismaService,
    vault as unknown as AiCredentialsVault,
    anthropicClients as unknown as AnthropicClientFactory,
    defaultProvider,
    activity as unknown as ActivityRecorder,
  );
  return { service, vault, rows };
}

describe('AiConfigService', () => {
  it('encrypts API keys, never returns secrets, and keeps existing key when changing only the model', async () => {
    const { service, vault } = createService();
    const actor = Actor.user('user-1');

    const saved = await service.saveConfig(
      'ws-1',
      {
        provider: AiProviderName.OpenAiCompatible,
        baseUrl: 'https://api.example.com/v1/',
        apiKey: 'sk-secret-value',
        model: 'model-v1',
      },
      actor,
    );

    expect(saved.configured).toBe(true);
    expect(saved.source).toBe(AiConfigSource.Workspace);
    expect(saved.provider).toBe(AiProviderName.OpenAiCompatible);
    expect(saved.baseUrl).toBe('https://api.example.com/v1');
    expect(saved.model).toBe('model-v1');
    expect(saved.hasApiKey).toBe(true);
    expect(saved.status).toBe(AiConfigStatus.CONNECTED);
    expect(JSON.stringify(saved)).not.toContain('sk-secret-value');

    // Change model without re-entering API key
    const updated = await service.saveConfig(
      'ws-1',
      {
        provider: AiProviderName.OpenAiCompatible,
        baseUrl: 'https://api.example.com/v1',
        model: 'model-v2',
      },
      actor,
    );
    expect(updated.model).toBe('model-v2');
    expect(updated.hasApiKey).toBe(true);
    expect(vault.open).toHaveBeenCalledWith('ws-1', 'sealed:sk-secret-value');

    // Workspace isolation: ws-2 remains unconfigured
    const other = await service.getConfig('ws-2');
    expect(other.configured).toBe(false);
    expect(other.source).toBe(AiConfigSource.None);

    // Dynamic resolution uses ws-1 OpenAI-compatible provider with forceModel=true
    const resolved = await service.resolveForWorkspace('ws-1');
    expect(resolved.configured).toBe(true);
    expect(resolved.forceModel).toBe(true);
    expect(resolved.provider.name).toBe(AiProviderName.OpenAiCompatible);
    expect(resolved.provider.model).toBe('model-v2');
  });
});
