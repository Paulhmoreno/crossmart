import { describe, expect, it } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { CatalogSourceKind, OutOfStockPolicy, Prisma, ProductStatus } from '@crossmart/database';
import type { ProductDraft } from '../entities/product-draft.js';
import type { ProductDetailRecord } from '../repositories/product.queries.js';
import {
  assertSourceManagedDeleteAllowed,
  assertSourceManagedUpdateAllowed,
} from './source-ownership.rules.js';

function makeExisting(sourceKind: CatalogSourceKind): ProductDetailRecord {
  const now = new Date();
  return {
    id: 'prod-1',
    workspaceId: 'ws-1',
    sourceKind,
    sourceConnectionId: sourceKind === CatalogSourceKind.ODOO ? 'conn-1' : null,
    sourceExternalId: sourceKind === CatalogSourceKind.ODOO ? '1001' : null,
    sourceMetadata: null,
    handle: 'sample-widget',
    title: 'Original ERP Title',
    descriptionHtml: '',
    vendor: 'BrandA',
    productType: 'Accessories',
    tags: [],
    status: ProductStatus.DRAFT,
    condition: null,
    optionNames: [],
    variants: [
      {
        id: 'var-1',
        workspaceId: 'ws-1',
        productId: 'prod-1',
        sourceExternalId: sourceKind === CatalogSourceKind.ODOO ? '1001' : null,
        position: 0,
        sku: 'SKU-100',
        barcode: '0000000000001',
        optionValues: [],
        price: new Prisma.Decimal('12.00'),
        compareAtPrice: null,
        cost: new Prisma.Decimal('4.50'),
        weightGrams: null,
        requiresShipping: true,
        taxable: true,
        outOfStockPolicy: OutOfStockPolicy.STOP_SELLING,
        createdAt: now,
        updatedAt: now,
        inventoryItem: {
          id: 'inv-1',
          workspaceId: 'ws-1',
          variantId: 'var-1',
          tracked: true,
          available: 5,
          reserved: 0,
          updatedAt: now,
        },
      },
    ],
    media: [
      {
        id: 'med-1',
        workspaceId: 'ws-1',
        productId: 'prod-1',
        url: 'http://localhost:3300/media/original.png',
        altText: 'Main',
        position: 0,
        sourceManaged: sourceKind === CatalogSourceKind.ODOO,
        sourceKey: sourceKind === CatalogSourceKind.ODOO ? 'odoo:tmpl:1001:abc' : null,
        createdAt: now,
      },
    ],
    documents: [],
    createdAt: now,
    updatedAt: now,
  };
}

function makeDraft(overrides: Partial<ProductDraft> = {}): ProductDraft {
  return {
    handle: 'sample-widget',
    title: 'Original ERP Title',
    descriptionHtml: '',
    vendor: 'BrandA',
    productType: 'Accessories',
    tags: [],
    status: ProductStatus.DRAFT,
    condition: null,
    optionNames: [],
    variants: [
      {
        id: 'var-1',
        sku: 'SKU-100',
        barcode: '0000000000001',
        optionValues: [],
        price: '12.00',
        compareAtPrice: undefined,
        cost: '4.50',
        weightGrams: undefined,
        requiresShipping: true,
        taxable: true,
        outOfStockPolicy: OutOfStockPolicy.STOP_SELLING,
        inventory: { tracked: true, quantity: 5 },
      },
    ],
    media: [{ url: 'http://localhost:3300/media/original.png', altText: 'Main' }],
    ...overrides,
  };
}

describe('source-ownership.rules', () => {
  it('allows any edit on manual products', () => {
    const existing = makeExisting(CatalogSourceKind.MANUAL);
    const draft = makeDraft({
      variants: [{ ...makeDraft().variants[0], sku: 'NEW-SKU', price: '19.00' }],
      media: [],
    });
    expect(() => assertSourceManagedUpdateAllowed(existing, draft)).not.toThrow();
    expect(() => assertSourceManagedDeleteAllowed(CatalogSourceKind.MANUAL)).not.toThrow();
  });

  it('allows commercial edits and adding extra photos on Odoo products', () => {
    const existing = makeExisting(CatalogSourceKind.ODOO);
    const draft = makeDraft({
      title: 'Commercial Title in Spanish',
      descriptionHtml: '<p>Enhanced marketing description</p>',
      tags: ['featured', 'cable'],
      productType: 'Commercial Category',
      status: ProductStatus.ACTIVE,
      media: [
        { url: 'http://localhost:3300/media/original.png', altText: 'Updated alt' },
        { url: 'http://localhost:3300/media/commercial-extra.png', altText: 'Extra' },
      ],
    });
    expect(() => assertSourceManagedUpdateAllowed(existing, draft)).not.toThrow();
  });

  it('rejects editing SKU, barcode, base price, stock, variants, or removing Odoo photos', () => {
    const existing = makeExisting(CatalogSourceKind.ODOO);

    expect(() =>
      assertSourceManagedUpdateAllowed(
        existing,
        makeDraft({ variants: [{ ...makeDraft().variants[0], sku: 'HACK' }] }),
      ),
    ).toThrow(BadRequestException);

    expect(() =>
      assertSourceManagedUpdateAllowed(
        existing,
        makeDraft({ variants: [{ ...makeDraft().variants[0], barcode: '9999999999999' }] }),
      ),
    ).toThrow(BadRequestException);

    expect(() =>
      assertSourceManagedUpdateAllowed(
        existing,
        makeDraft({ variants: [{ ...makeDraft().variants[0], price: '12.50' }] }),
      ),
    ).toThrow(BadRequestException);

    expect(() =>
      assertSourceManagedUpdateAllowed(
        existing,
        makeDraft({
          variants: [{ ...makeDraft().variants[0], inventory: { tracked: true, quantity: 99 } }],
        }),
      ),
    ).toThrow(BadRequestException);

    expect(() => assertSourceManagedUpdateAllowed(existing, makeDraft({ media: [] }))).toThrow(
      BadRequestException,
    );

    expect(() => assertSourceManagedDeleteAllowed(CatalogSourceKind.ODOO)).toThrow(
      ConflictException,
    );
  });
});
