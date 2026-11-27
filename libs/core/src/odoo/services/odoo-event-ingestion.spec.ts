import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { Actor } from '../../activity/entities/actor.js';
import { signCrossmartOdooPayload } from '../client/odoo-operational.client.js';
import { OdooEventIngestionService } from './odoo-event-ingestion.service.js';

describe('OdooEventIngestionService — Module Pairing & Bidirectional Auth', () => {
  function makeFixture(odooUrl = 'http://127.0.0.1:18069') {
    let storedSettings: Record<string, unknown> = {};
    const prisma = {
      odooConnection: {
        findUnique: vi.fn().mockImplementation(async () => ({
          id: 'conn-uuid-1',
          workspaceId: 'ws-1',
          displayName: 'Odoo Test',
          url: odooUrl,
          settings: storedSettings,
        })),
        update: vi.fn().mockImplementation(async ({ data }: { data: { settings?: Record<string, unknown> } }) => {
          if (data.settings) storedSettings = data.settings;
          return {};
        }),
      },
      odooInboundEvent: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    } as never;

    const vault = {
      seal: vi.fn().mockImplementation(async (_ws: string, payload: { apiKey: string }) => `sealed:${payload.apiKey}`),
      open: vi.fn().mockImplementation(async (_ws: string, sealed: string) => ({ apiKey: sealed.replace('sealed:', '') })),
    } as never;

    const operationalClient = {
      getHealth: vi.fn().mockResolvedValue({
        installed: true,
        moduleVersion: '18.0.1.0.0',
        capabilities: {
          eventSync: true,
          incrementalReconcile: true,
          createPartner: false,
          createSaleOrder: false,
          reserveStock: false,
          releaseStock: false,
          cancelOrder: false,
          draftInvoice: false,
          postInvoice: false,
          writesSuspended: false,
        },
        outbox: { pending: 0, failed: 0, lastCommAt: null, lastSuccessAt: null },
      }),
    } as never;

    const service = new OdooEventIngestionService(
      prisma,
      {} as never,
      {} as never,
      operationalClient,
      vault,
      { record: vi.fn().mockResolvedValue(undefined) } as never,
    );

    return { service, operationalClient, getSettings: () => storedSettings };
  }

  it('generates cryptographic secret, verifies inbound ping, confirms bidirectional, and rejects rotated/revoked secret', async () => {
    const { service } = makeFixture();
    const gen = await service.generatePairingCredentials('ws-1', Actor.system(), false);
    expect(gen.connectionId).toBe('conn-uuid-1');
    expect(gen.apiSecret.length).toBeGreaterThanOrEqual(32);
    expect(gen.secretMasked).toMatch(/^••••••.{4}$/);

    // Before inbound ping, testModulePairing reports outbound_only (never falsely verified!)
    const beforePing = await service.testModulePairing('ws-1');
    expect(beforePing.outboundOk).toBe(true);
    expect(beforePing.inboundOk).toBe(false);
    expect(beforePing.ok).toBe(false);
    expect(beforePing.state).toBe('outbound_only');

    // Valid inbound ping from Odoo
    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ connectionId: 'conn-uuid-1', ping: true });
    const sig = signCrossmartOdooPayload(gen.apiSecret, ts, body);
    const pingRes = await service.handlePing('conn-uuid-1', ts, sig, body);
    expect(pingRes.ok).toBe(true);

    // Now both directions are verified!
    const afterPing = await service.testModulePairing('ws-1');
    expect(afterPing.ok).toBe(true);
    expect(afterPing.state).toBe('verified');

    // Rotate secret -> old secret is rejected immediately
    const rotated = await service.generatePairingCredentials('ws-1', Actor.system(), true);
    expect(rotated.apiSecret).not.toBe(gen.apiSecret);
    await expect(service.handlePing('conn-uuid-1', ts, sig, body)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    // Revoke secret -> new secret is also rejected
    await service.revokePairingCredentials('ws-1', Actor.system());
    const newSig = signCrossmartOdooPayload(rotated.apiSecret, ts, body);
    await expect(service.handlePing('conn-uuid-1', ts, newSig, body)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('flags local Crossmart URL when Odoo is remote', async () => {
    const prevCrossmart = process.env.CROSSMART_PUBLIC_API_URL;
    const prevPublic = process.env.PUBLIC_API_URL;
    const prevApiPublic = process.env.API_PUBLIC_URL;
    delete process.env.CROSSMART_PUBLIC_API_URL;
    delete process.env.PUBLIC_API_URL;
    delete process.env.API_PUBLIC_URL;
    try {
      const { service } = makeFixture('https://erp.example.com');
      const gen = await service.generatePairingCredentials('ws-1', Actor.system(), false);
      expect(gen.crossmartApiUrl).toBe('http://localhost:3300');
      expect(gen.isLocalOnlyUrl).toBe(true);
      expect(gen.odooIsRemote).toBe(true);
    } finally {
      if (prevCrossmart !== undefined) process.env.CROSSMART_PUBLIC_API_URL = prevCrossmart;
      if (prevPublic !== undefined) process.env.PUBLIC_API_URL = prevPublic;
      if (prevApiPublic !== undefined) process.env.API_PUBLIC_URL = prevApiPublic;
    }
  });
});
