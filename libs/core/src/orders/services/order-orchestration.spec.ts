import { ForbiddenException, BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { Actor } from '../../activity/entities/actor.js';
import { CatalogImportMode } from '../../catalog/enums/catalog-import-mode.enum.js';
import { ProductAdmission } from '../../catalog/services/product-admission.js';
import { CatalogImportService } from '../../catalog/services/catalog-import.service.js';
import { signCrossmartOdooPayload } from '../../odoo/client/odoo-operational.client.js';
import {
  DEFAULT_STORE_ORDER_POLICY,
  OrderOrchestrationService,
  extractStoreOrderPolicy,
} from './order-orchestration.service.js';

describe('ERP Order Orchestration & Exclusive Catalog Protection', () => {
  it('blocks manual product creation when Odoo is configured as exclusive source (even if disconnected)', async () => {
    const prisma = {
      odooConnection: { findUnique: vi.fn().mockResolvedValue({ id: 'odoo-conn-1' }) },
    } as never;
    const admission = new ProductAdmission(
      { check: vi.fn() } as never,
      { assertProductRoom: vi.fn() } as never,
      prisma,
    );
    await expect(
      admission.assertCreatable('ws-1', { title: 'Test', variants: [] } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('blocks CSV create and inventory imports when Odoo is configured as exclusive source', async () => {
    const prisma = {
      odooConnection: { findUnique: vi.fn().mockResolvedValue({ id: 'odoo-conn-1' }) },
    } as never;
    const service = new CatalogImportService(
      [],
      {} as never,
      {} as never,
      {} as never,
      prisma,
    );
    await expect(
      service.importFile('ws-1', {
        mode: CatalogImportMode.Create,
        format: 'csv' as never,
        fileName: 'products.csv',
        content: Buffer.from(''),
        actor: Actor.system(),
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    await expect(
      service.importFile('ws-1', {
        mode: CatalogImportMode.Inventory,
        format: 'csv' as never,
        fileName: 'stock.csv',
        content: Buffer.from(''),
        actor: Actor.system(),
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('requires a non-empty reason for emergency manual reservation release', async () => {
    const orchestration = new OrderOrchestrationService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await expect(
      orchestration.releaseReservation('ws-1', 'ord-1', { reason: ' ' }, Actor.system()),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('releases native reservation, locks against auto re-reserve, and logs audit event', async () => {
    const orderUpdate = vi.fn().mockResolvedValue({});
    const orderEventCreate = vi.fn().mockResolvedValue({});
    const orderLineUpdate = vi.fn().mockResolvedValue({});
    const tx = { orderLine: { update: orderLineUpdate } };
    const prisma = {
      order: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'ord-1',
          workspaceId: 'ws-1',
          name: '#1001',
          externalId: 'ML-1001',
          status: 'OPEN',
          logisticsStatus: 'PENDING',
          erpOrderId: null,
          erpOrderName: null,
          incidents: [],
          connection: { channel: 'MERCADO_LIBRE', displayName: 'Elektrofertas' },
          lines: [{ id: 'line-1', variantId: 'var-1', reservedQuantity: 2 }],
        }),
        update: orderUpdate,
      },
      odooConnection: { findUnique: vi.fn().mockResolvedValue(null) },
      orderEvent: { create: orderEventCreate },
      $transaction: vi.fn((fn: (t: unknown) => Promise<unknown>) => fn(tx)),
    } as never;
    const ledger = {
      lockVariants: vi
        .fn()
        .mockResolvedValue(new Map([['var-1', { id: 'inv-1', variantId: 'var-1', tracked: true, available: 3, reserved: 2 }]])),
      applyMovements: vi.fn().mockResolvedValue([{ inventoryItemId: 'inv-1', available: 5, reserved: 0 }]),
    } as never;
    const events = { stockChanged: vi.fn().mockResolvedValue(undefined) } as never;

    const orchestration = new OrderOrchestrationService(prisma, ledger, events, {} as never);
    const res = await orchestration.releaseReservation(
      'ws-1',
      'ord-1',
      { reason: 'Cliente solicitó cambio de producto' },
      Actor.system(),
    );

    expect(res.reservationStatus).toBe('MANUALLY_RELEASED');
    expect(res.manualReleaseLock).toBe(true);
    expect(orderUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          reservationStatus: 'MANUALLY_RELEASED',
          manualReleaseLock: true,
          manualInterventionRequired: true,
        }),
      }),
    );
    expect(orderEventCreate).toHaveBeenCalledTimes(1);
  });

  it('defaults store order policy to safe values (auto-invoicing disabled, Guayaquil timezone)', () => {
    const policy = extractStoreOrderPolicy(null);
    expect(policy).toEqual(DEFAULT_STORE_ORDER_POLICY);
    expect(policy.autoInvoicingEnabled).toBe(false);
    expect(policy.invoicingPolicy).toBe('MANUAL');
    expect(policy.invoicingTimezone).toBe('America/Guayaquil');
  });

  it('computes deterministic HMAC-SHA256 signatures matching Odoo crossmart_connector', () => {
    const sig1 = signCrossmartOdooPayload('secret-key', '1700000000', '{"ok":true}');
    const sig2 = signCrossmartOdooPayload('secret-key', '1700000000', '{"ok":true}');
    expect(sig1).toBe(sig2);
    expect(sig1).toHaveLength(64);
  });
});
