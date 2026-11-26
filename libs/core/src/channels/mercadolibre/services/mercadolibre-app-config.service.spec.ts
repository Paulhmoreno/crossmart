import { ConflictException } from '@nestjs/common';
import { ChannelType, MercadoLibreApp } from '@crossmart/connectors';
import { MercadoLibreAppConfigService } from './mercadolibre-app-config.service.js';

describe('MercadoLibreAppConfigService', () => {
  function setup(envFallback: { clientId: string; clientSecret: string } | null = null) {
    let storedRow: {
      channel: string;
      clientId: string;
      sealedSecret: string;
      encryptionWorkspaceId: string;
      updatedById: string | null;
    } | null = null;
    let activeCount = 0;

    const prisma = {
      channelAppConfig: {
        findUnique: vi.fn(() => Promise.resolve(storedRow)),
        upsert: vi.fn(({ create }: { create: NonNullable<typeof storedRow> }) => {
          storedRow = { ...create };
          return Promise.resolve(storedRow);
        }),
      },
      channelConnection: {
        count: vi.fn(() => Promise.resolve(activeCount)),
      },
    };

    const encryption = {
      encrypt: vi.fn((_scope: unknown, plain: string) => Promise.resolve(`sealed:${plain}`)),
      decrypt: vi.fn((_scope: unknown, sealed: string) =>
        Promise.resolve(sealed.replace(/^sealed:/, '')),
      ),
    };

    const appConfig = {
      apiPublicUrl: 'https://api.example.com',
    };

    const mlApp = new MercadoLibreApp(envFallback);
    const service = new MercadoLibreAppConfigService(
      prisma as never,
      encryption as never,
      appConfig as never,
      mlApp,
    );

    return {
      service,
      mlApp,
      encryption,
      setActiveConnections: (count: number) => {
        activeCount = count;
      },
    };
  }

  it('uses env fallback when no DB record exists, and prefers DB once saved without exposing secrets', async () => {
    const { service, mlApp, encryption } = setup({
      clientId: '111111',
      clientSecret: 'env-secret',
    });
    await service.onModuleInit();

    const before = await service.getStatus();
    expect(before).toEqual({
      configured: true,
      source: 'env',
      clientId: '111111',
      hasClientSecret: true,
      redirectUri: 'https://api.example.com/api/v1/channels/mercado_libre/oauth/callback',
      activeConnections: 0,
    });
    expect(before).not.toHaveProperty('clientSecret');

    const after = await service.save(
      'ws-1',
      { clientId: '222222', clientSecret: 'db-secret' },
      'user-1',
    );
    expect(after).toMatchObject({
      configured: true,
      source: 'database',
      clientId: '222222',
      hasClientSecret: true,
    });
    expect(after).not.toHaveProperty('clientSecret');
    expect(encryption.encrypt).toHaveBeenCalledWith(
      { workspaceId: 'ws-1', context: 'channel_app:mercado_libre' },
      'db-secret',
    );
    expect(mlApp.settings()).toEqual({ clientId: '222222', clientSecret: 'db-secret' });
  });

  it('blocks changing App ID while active connections exist, while allowing secret rotation for same App ID', async () => {
    const { service, mlApp, setActiveConnections } = setup();
    await service.onModuleInit();
    await service.save('ws-1', { clientId: '555555', clientSecret: 'sec-1' }, 'user-1');
    setActiveConnections(1);

    await expect(
      service.save('ws-1', { clientId: '999999', clientSecret: 'sec-2' }, 'user-1'),
    ).rejects.toBeInstanceOf(ConflictException);

    const rotated = await service.save(
      'ws-1',
      { clientId: '555555', clientSecret: 'sec-rotated' },
      'user-1',
    );
    expect(rotated.clientId).toBe('555555');
    expect(mlApp.settings()).toEqual({ clientId: '555555', clientSecret: 'sec-rotated' });
    expect(ChannelType.MercadoLibre).toBe('mercado_libre');
  });
});
