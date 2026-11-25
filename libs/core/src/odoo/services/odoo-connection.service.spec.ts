import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { OdooConnectionStatus } from '@crossmart/database';
import { Actor } from '../../activity/entities/actor.js';
import { OdooConnectionService } from './odoo-connection.service.js';

function createServiceHarness(existingConnection: Record<string, unknown> | null, syncedCount = 0) {
  const prisma = {
    odooConnection: {
      findUnique: vi.fn().mockResolvedValue(existingConnection),
      update: vi.fn().mockImplementation(async ({ data }) => ({
        id: 'conn-1',
        workspaceId: 'ws-1',
        ...existingConnection,
        ...data,
        connectedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
      create: vi.fn(),
    },
    product: {
      count: vi.fn().mockResolvedValue(syncedCount),
      findMany: vi.fn().mockResolvedValue([]),
    },
    odooSyncRun: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
  const client = {
    discoverInstance: vi.fn().mockResolvedValue({
      serverVersion: '18.0',
      companyName: 'Sample Co',
      currency: 'USD',
      productCount: 10,
      warehouses: [],
      pricelists: [],
      categories: [],
      brandField: null,
      hasProductDocuments: true,
      hasProductImages: false,
    }),
  };
  const vault = {
    seal: vi.fn().mockResolvedValue('sealed-token'),
    open: vi.fn().mockResolvedValue({ apiKey: 'existing-key' }),
  };
  const activity = {
    record: vi.fn().mockResolvedValue(undefined),
  };

  const service = new OdooConnectionService(
    prisma as never,
    client as never,
    vault as never,
    activity as never,
  );
  return { service, prisma, client };
}

describe('OdooConnectionService source identity protection', () => {
  const existing = {
    id: 'conn-1',
    workspaceId: 'ws-1',
    displayName: 'Sample Co',
    url: 'https://erp.example.com',
    database: 'prod_db',
    username: 'sync@example.com',
    sealedCredentials: 'sealed-old',
    status: OdooConnectionStatus.CONNECTED,
    statusReason: null,
    settings: {},
    lastTestedAt: null,
    lastSyncedAt: null,
    connectedAt: new Date(),
    disconnectedAt: null,
  };

  it('blocks changing URL or database when Odoo products are already synced', async () => {
    const { service, client } = createServiceHarness(existing, 3);

    await expect(
      service.upsertConnection(
        'ws-1',
        {
          url: 'https://staging.example.com',
          database: 'prod_db',
          username: 'sync@example.com',
          apiKey: 'new-key',
        },
        Actor.system(),
      ),
    ).rejects.toThrow(ConflictException);

    await expect(
      service.upsertConnection(
        'ws-1',
        {
          url: 'https://erp.example.com',
          database: 'other_db',
          username: 'sync@example.com',
          apiKey: 'new-key',
        },
        Actor.system(),
      ),
    ).rejects.toThrow(ConflictException);

    expect(client.discoverInstance).not.toHaveBeenCalled();
  });

  it('allows credential rotation for the same normalized URL and database', async () => {
    const { service, prisma } = createServiceHarness(existing, 3);

    const view = await service.upsertConnection(
      'ws-1',
      {
        url: 'https://ERP.Example.com/',
        database: 'PROD_DB',
        username: 'readonly@example.com',
        apiKey: 'rotated-key',
      },
      Actor.system(),
    );

    expect(view.status).toBe(OdooConnectionStatus.CONNECTED);
    expect(prisma.odooConnection.update).toHaveBeenCalledTimes(1);
  });

  it('allows changing URL or database when zero Odoo products exist', async () => {
    const { service, prisma } = createServiceHarness(existing, 0);

    const view = await service.upsertConnection(
      'ws-1',
      {
        url: 'https://staging.example.com',
        database: 'staging_db',
        username: 'sync@example.com',
        apiKey: 'staging-key',
      },
      Actor.system(),
    );

    expect(view.url).toBe('https://staging.example.com');
    expect(prisma.odooConnection.update).toHaveBeenCalledTimes(1);
  });
});
