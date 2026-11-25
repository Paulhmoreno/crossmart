import { ProductDocumentKind } from '@crossmart/database';
import { productDetail } from '../../listings/testing/listing.fixtures.js';
import { ContentQualityTier } from '../enums/content-quality-tier.enum.js';
import { classifyProductQualityTier, promptProduct } from './prompt-product.js';

describe('promptProduct', () => {
  it('extracts safe commercial ERP metadata while excluding costs, URLs, taxes, and private docs', () => {
    const base = productDetail();
    const result = promptProduct({
      ...base,
      sourceMetadata: {
        originalName: 'ADAPTADOR USB-C AC600',
        originalCategory: 'Computacion / Redes',
        sourceOrigin: 'https://private-erp.example#prod_db',
        taxes: ['VAT 15%'],
        weightKg: 0.25,
        customFields: { internalSupplierNote: 'confidential' },
      },
      variants: [
        {
          ...base.variants[0],
          sku: 'SKU-100',
          barcode: '0123456789012',
          cost: '9.99',
          weightGrams: 180,
        },
      ],
      documents: [
        {
          id: 'doc-1',
          sourceExternalId: 'att-1',
          name: 'ficha-tecnica-ac600.pdf',
          mimetype: 'application/pdf',
          byteSize: 1024,
          kind: ProductDocumentKind.DATASHEET,
          isPublic: true,
          createdAt: new Date(),
        },
        {
          id: 'doc-2',
          sourceExternalId: 'att-2',
          name: 'factura-importacion.pdf',
          mimetype: 'application/pdf',
          byteSize: 2048,
          kind: ProductDocumentKind.INTERNAL,
          isPublic: false,
          createdAt: new Date(),
        },
      ],
    });

    expect(result.sourceOriginalName).toBe('ADAPTADOR USB-C AC600');
    expect(result.sourceOriginalCategory).toBe('Computacion / Redes');
    expect(result.skus).toEqual(['SKU-100']);
    expect(result.barcodes).toEqual(['0123456789012']);
    expect(result.weightGrams).toBe(180);
    expect(result.technicalDocuments).toEqual(['ficha-tecnica-ac600.pdf']);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('9.99');
    expect(serialized).not.toContain('private-erp.example');
    expect(serialized).not.toContain('VAT 15%');
    expect(serialized).not.toContain('confidential');
    expect(serialized).not.toContain('factura-importacion.pdf');
    expect(classifyProductQualityTier(result).tier).toBe(ContentQualityTier.VerifiedWithSources);
  });

  it('classifies products across assisted and generic provisional tiers deterministically', () => {
    expect(
      classifyProductQualityTier({
        title: 'CALCULADORA CIENTIFICA MODELO X200 ACME',
        descriptionHtml: '',
        vendor: 'ACME',
        productType: 'Calculadoras',
        tags: [],
        optionNames: [],
        optionValues: [],
        barcodes: ['0123456789012'],
      }).tier,
    ).toBe(ContentQualityTier.CommercialAssisted);

    expect(
      classifyProductQualityTier({
        title: 'MOCHILA DE LAPTOP RECTANGULAR',
        descriptionHtml: '',
        vendor: 'GENERIC',
        productType: 'Estuches',
        tags: [],
        optionNames: [],
        optionValues: [],
      }).tier,
    ).toBe(ContentQualityTier.GenericProvisional);
  });
});
