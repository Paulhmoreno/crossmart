import { describe, expect, it, vi } from 'vitest';
import {
  CatalogSourceKind,
  OdooSyncMode,
  OdooSyncRunStatus,
  OutOfStockPolicy,
  ProductDocumentKind,
  ProductStatus,
} from '@crossmart/database';
import type { OdooTemplateSnapshot } from '../client/odoo-readonly.client.js';
import { OdooSyncService } from './odoo-sync.service.js';

const SAMPLE_PNG_BASE64 = Buffer.from('sample-image-bytes-1').toString('base64');
const SAMPLE_PNG_2_BASE64 = Buffer.from('sample-image-bytes-2').toString('base64');

function makeExistingProduct(overrides: Record<string, unknown> = {}) {
  return {
    id: 'prod-1',
    workspaceId: 'ws-1',
    sourceKind: CatalogSourceKind.ODOO,
    sourceConnectionId: 'conn-1',
    sourceExternalId: '1001',
    sourceMetadata: { sourceOrigin: 'https://erp.example.com#prod_db' },
    handle: 'sample-widget',
    title: 'Custom Commercial Title',
    descriptionHtml: '<p>Custom description</p>',
    vendor: 'Sample Brand',
    productType: 'Accessories',
    tags: ['featured'],
    status: ProductStatus.ACTIVE,
    optionNames: [],
    variants: [
      {
        id: 'var-1',
        workspaceId: 'ws-1',
        productId: 'prod-1',
        sourceExternalId: '2001',
        position: 0,
        sku: 'SKU-1001',
        barcode: '0000000000001',
        optionValues: [],
        price: '12.00',
        cost: '4.50',
        weightGrams: null,
        requiresShipping: true,
        taxable: true,
        outOfStockPolicy: OutOfStockPolicy.STOP_SELLING,
        inventoryItem: {
          id: 'inv-1',
          variantId: 'var-1',
          tracked: true,
          available: 5,
          reserved: 0,
        },
      },
    ],
    media: [
      {
        id: 'med-main',
        url: 'http://localhost:3300/media/main.webp',
        altText: 'Main',
        position: 0,
        sourceManaged: true,
        sourceKey: 'odoo:tmpl:1001:existingmainhash',
      },
      {
        id: 'med-doc-1',
        url: 'http://localhost:3300/media/doc-1.webp',
        altText: 'Gallery 1',
        position: 1,
        sourceManaged: true,
        sourceKey: 'odoo:doc:9001:existingdochash1',
      },
    ],
    documents: [
      {
        id: 'doc-row-1',
        sourceExternalId: 'att:9002',
        name: 'ficha_tecnica.pdf',
        mimetype: 'application/pdf',
        byteSize: 1024,
        kind: ProductDocumentKind.DATASHEET,
        isPublic: false,
        checksum: 'abc',
      },
    ],
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<OdooTemplateSnapshot> = {}): OdooTemplateSnapshot {
  return {
    id: 1001,
    name: 'ERP Original Name',
    sku: 'SKU-1001',
    barcode: '0000000000001',
    brand: 'Sample Brand',
    category: 'Accessories',
    descriptionHtml: '',
    listPrice: 12,
    cost: 4.5,
    weightKg: null,
    volume: null,
    taxNames: [],
    taxable: true,
    optionNames: [],
    mainImageBase64: SAMPLE_PNG_BASE64,
    variants: [
      {
        id: 2001,
        sku: 'SKU-1001',
        barcode: '0000000000001',
        price: 12,
        cost: 4.5,
        weightKg: null,
        volume: null,
        qtyAvailable: 5,
        freeQty: 5,
        optionValues: [],
        imageBase64: null,
      },
    ],
    attachments: [],
    attachmentsLoaded: true,
    attachmentError: null,
    customFieldValues: {},
    ...overrides,
  };
}

function createSyncHarness(
  existingProduct: Record<string, unknown>,
  snapshot: OdooTemplateSnapshot,
) {
  const tx = {
    product: { update: vi.fn().mockResolvedValue({}) },
    variant: { update: vi.fn().mockResolvedValue({}), create: vi.fn().mockResolvedValue({}) },
    inventoryItem: { update: vi.fn().mockResolvedValue({}) },
    productMedia: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    productDocument: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      upsert: vi.fn().mockResolvedValue({}),
    },
  };

  const runUpdates: Record<string, unknown>[] = [];
  const prisma = {
    odooSyncRun: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'run-1',
        workspaceId: 'ws-1',
        connectionId: 'conn-1',
        mode: OdooSyncMode.SELECTED,
        filter: { templateIds: [1001] },
      }),
      update: vi.fn().mockImplementation(async ({ data }) => {
        runUpdates.push(data);
        return data;
      }),
    },
    odooConnection: {
      update: vi.fn().mockResolvedValue({}),
    },
    product: {
      findFirst: vi.fn().mockResolvedValue(existingProduct),
      create: vi.fn(),
    },
    variant: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    $transaction: vi.fn().mockImplementation(async (arg: unknown) => {
      if (typeof arg === 'function') {
        return (arg as (client: typeof tx) => Promise<unknown>)(tx);
      }
      return Promise.all(arg as Promise<unknown>[]);
    }),
  };

  const connections = {
    openActiveConnection: vi.fn().mockResolvedValue({
      connection: { id: 'conn-1', displayName: 'Sample Co' },
      credentials: {
        url: 'https://erp.example.com',
        database: 'prod_db',
        username: 'sync@example.com',
        apiKey: 'secret',
      },
      settings: { discovered: { currency: 'USD' } },
    }),
  };

  let uploadCounter = 0;
  const media = {
    uploadProductImage: vi.fn().mockImplementation(async () => {
      uploadCounter += 1;
      return { url: `http://localhost:3300/media/uploaded-${uploadCounter}.webp` };
    }),
  };

  const client = {
    resolveTemplateIds: vi.fn().mockResolvedValue([snapshot.id]),
    fetchTemplateBatch: vi.fn().mockResolvedValue([snapshot]),
    selectStockQuantity: vi.fn().mockReturnValue(5),
  };

  const ledger = {
    lockItems: vi
      .fn()
      .mockResolvedValue([{ id: 'inv-1', variantId: 'var-1', tracked: true, available: 5 }]),
    applyMovement: vi.fn(),
  };

  const service = new OdooSyncService(
    prisma as never,
    connections as never,
    client as never,
    { enqueue: vi.fn() } as never,
    media as never,
    ledger as never,
    { record: vi.fn().mockResolvedValue(undefined) } as never,
    { productsChanged: vi.fn().mockResolvedValue(undefined) } as never,
  );

  return { service, tx, runUpdates, media };
}

describe('OdooSyncService resilience and classification', () => {
  it('preserves existing photos and documents and flags issues when Odoo document read fails', async () => {
    const existing = makeExistingProduct();
    const snapshot = makeSnapshot({
      attachments: [],
      attachmentsLoaded: false,
      attachmentError: 'Odoo HTTP 503',
    });
    const { service, tx, runUpdates } = createSyncHarness(existing, snapshot);

    await service.runSync({ workspaceId: 'ws-1', runId: 'run-1' });

    // Existing document photo MUST be preserved in createMany
    const mediaPayload = tx.productMedia.createMany.mock.calls[0]?.[0]?.data as {
      url: string;
      sourceKey: string;
    }[];
    expect(mediaPayload.some((item) => item.url === 'http://localhost:3300/media/doc-1.webp')).toBe(
      true,
    );

    // ProductDocument rows MUST NOT be deleted or overwritten
    expect(tx.productDocument.deleteMany).not.toHaveBeenCalled();
    expect(tx.productDocument.upsert).not.toHaveBeenCalled();

    // Sync run MUST NOT report clean 0-error completion
    const finalUpdate = runUpdates[runUpdates.length - 1];
    expect(finalUpdate.failedCount).toBe(1);
    expect(finalUpdate.errorMessage).toContain('Odoo HTTP 503');
    expect((finalUpdate.issues as unknown[]).length).toBe(1);
  });

  it('distinguishes a legitimate empty document response from a read failure', async () => {
    const existing = makeExistingProduct();
    const snapshot = makeSnapshot({
      attachments: [],
      attachmentsLoaded: true,
      attachmentError: null,
    });
    const { service, tx, runUpdates } = createSyncHarness(existing, snapshot);

    await service.runSync({ workspaceId: 'ws-1', runId: 'run-1' });

    expect(tx.productDocument.deleteMany).toHaveBeenCalledTimes(1);
    const finalUpdate = runUpdates[runUpdates.length - 1];
    expect(finalUpdate.status).toBe(OdooSyncRunStatus.COMPLETED);
    expect(finalUpdate.failedCount).toBe(0);
    expect(finalUpdate.errorMessage).toBeNull();
  });

  it('blocks overwriting a product belonging to a different Odoo sourceOrigin', async () => {
    const existing = makeExistingProduct({
      sourceMetadata: { sourceOrigin: 'https://other-erp.example.com#other_db' },
    });
    const snapshot = makeSnapshot();
    const { service, tx, runUpdates } = createSyncHarness(existing, snapshot);

    await service.runSync({ workspaceId: 'ws-1', runId: 'run-1' });

    expect(tx.product.update).not.toHaveBeenCalled();
    const finalUpdate = runUpdates[runUpdates.length - 1];
    expect(finalUpdate.status).toBe(OdooSyncRunStatus.FAILED);
    expect(finalUpdate.failedCount).toBe(1);
  });

  it('imports variant product.document images to gallery while keeping loose/internal images private', async () => {
    const existing = makeExistingProduct({ media: [], documents: [] });
    const snapshot = makeSnapshot({
      attachmentsLoaded: true,
      attachments: [
        {
          id: 9101,
          documentId: 501,
          fromProductDocument: true,
          variantId: 2001,
          attachedOnSale: 'hidden',
          name: 'variant-angle-2.png',
          mimetype: 'image/png',
          fileSize: 512,
          isPublic: false,
          datasBase64: SAMPLE_PNG_2_BASE64,
        },
        {
          id: 9102,
          documentId: null,
          fromProductDocument: false,
          variantId: null,
          attachedOnSale: null,
          name: 'chatter-photo.png',
          mimetype: 'image/png',
          fileSize: 512,
          isPublic: false,
          datasBase64: SAMPLE_PNG_2_BASE64,
        },
        {
          id: 9103,
          documentId: 502,
          fromProductDocument: true,
          variantId: null,
          attachedOnSale: 'hidden',
          name: 'factura_compra.png',
          mimetype: 'image/png',
          fileSize: 512,
          isPublic: false,
          datasBase64: SAMPLE_PNG_2_BASE64,
        },
      ],
    });
    const { service, tx } = createSyncHarness(existing, snapshot);

    await service.runSync({ workspaceId: 'ws-1', runId: 'run-1' });

    const mediaPayload = tx.productMedia.createMany.mock.calls[0]?.[0]?.data as {
      altText: string;
      sourceKey: string;
    }[];
    // Main image + variant product.document image = 2 gallery photos ONLY
    expect(mediaPayload.map((item) => item.altText)).toEqual([
      'ERP Original Name',
      'variant-angle-2.png',
    ]);

    // Loose chatter image + confidential invoice image stay private in ProductDocument
    const upsertedDocs = tx.productDocument.upsert.mock.calls.map(
      (call) => (call[0] as { create: { name: string; kind: ProductDocumentKind } }).create,
    );
    expect(upsertedDocs).toEqual([
      expect.objectContaining({ name: 'chatter-photo.png', kind: ProductDocumentKind.INTERNAL }),
      expect.objectContaining({ name: 'factura_compra.png', kind: ProductDocumentKind.INTERNAL }),
    ]);
  });
});
