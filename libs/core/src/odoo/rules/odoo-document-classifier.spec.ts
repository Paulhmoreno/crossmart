import { describe, expect, it } from 'vitest';
import { ProductDocumentKind } from '@crossmart/database';
import {
  buildOdooMediaKey,
  buildOdooSourceOrigin,
  classifyOdooAttachment,
  formatOdooDecimal,
  kgToGrams,
  sha256Hex,
} from './odoo-document-classifier.js';

describe('odoo-document-classifier', () => {
  it('promotes only non-sensitive raster images from product.document to commercial gallery', () => {
    expect(
      classifyOdooAttachment('sample-photo-2.webp', 'image/webp', { fromProductDocument: true }),
    ).toEqual({
      isCommercialImage: true,
      documentKind: ProductDocumentKind.OTHER,
    });

    // Loose ir.attachment images (e.g. chatter uploads) must NEVER enter commercial gallery
    expect(
      classifyOdooAttachment('sample-photo-2.webp', 'image/webp', { fromProductDocument: false }),
    ).toEqual({
      isCommercialImage: false,
      documentKind: ProductDocumentKind.INTERNAL,
    });

    // Quote-embedded documents stay private
    expect(
      classifyOdooAttachment('sample-photo-2.webp', 'image/webp', {
        fromProductDocument: true,
        attachedOnSale: 'inside',
      }),
    ).toEqual({
      isCommercialImage: false,
      documentKind: ProductDocumentKind.DATASHEET,
    });
  });

  it('keeps confidential, internal, datasheet, and manual files private even when they are images', () => {
    expect(
      classifyOdooAttachment('ficha_tecnica.pdf', 'application/pdf', { fromProductDocument: true }),
    ).toEqual({
      isCommercialImage: false,
      documentKind: ProductDocumentKind.DATASHEET,
    });
    expect(
      classifyOdooAttachment('ficha_tecnica.png', 'image/png', { fromProductDocument: true }),
    ).toEqual({
      isCommercialImage: false,
      documentKind: ProductDocumentKind.DATASHEET,
    });
    expect(
      classifyOdooAttachment('Manual_Usuario.jpg', 'image/jpeg', { fromProductDocument: true }),
    ).toEqual({
      isCommercialImage: false,
      documentKind: ProductDocumentKind.MANUAL,
    });
    expect(
      classifyOdooAttachment('factura_proveedor.png', 'image/png', { fromProductDocument: true }),
    ).toEqual({
      isCommercialImage: false,
      documentKind: ProductDocumentKind.INTERNAL,
    });
    expect(
      classifyOdooAttachment('cotizacion_cliente.jpg', 'image/jpeg', { fromProductDocument: true }),
    ).toEqual({
      isCommercialImage: false,
      documentKind: ProductDocumentKind.INTERNAL,
    });
    expect(
      classifyOdooAttachment('screenshot_costos.png', 'image/png', { fromProductDocument: true }),
    ).toEqual({
      isCommercialImage: false,
      documentKind: ProductDocumentKind.INTERNAL,
    });
  });

  it('builds canonical source origin fingerprints and deterministic media keys', () => {
    expect(buildOdooSourceOrigin('https://ERP.Example.com///', ' Prod_DB ')).toBe(
      'https://erp.example.com#prod_db',
    );
    expect(buildOdooSourceOrigin('https://erp.example.com', 'prod_db')).toBe(
      'https://erp.example.com#prod_db',
    );
    expect(buildOdooSourceOrigin('https://staging.example.com', 'prod_db')).not.toBe(
      buildOdooSourceOrigin('https://erp.example.com', 'prod_db'),
    );

    const digest = sha256Hex(Buffer.from('sample-bytes'));
    expect(buildOdooMediaKey('doc', 1001, digest)).toBe(`odoo:doc:1001:${digest.slice(0, 16)}`);
    expect(formatOdooDecimal(12)).toBe('12.00');
    expect(formatOdooDecimal(4.505)).toBe('4.51');
    expect(kgToGrams(0.45)).toBe(450);
    expect(kgToGrams(0)).toBeNull();
  });
});
