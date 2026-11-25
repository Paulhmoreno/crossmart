import { describe, expect, it } from 'vitest';
import { ProductDocumentKind } from '@crossmart/database';
import {
  buildOdooMediaKey,
  classifyOdooAttachment,
  formatOdooDecimal,
  kgToGrams,
  sha256Hex,
} from './odoo-document-classifier.js';

describe('odoo-document-classifier', () => {
  it('classifies commercial images separately from technical and internal documents', () => {
    expect(classifyOdooAttachment('sample-photo-2.webp', 'image/webp')).toEqual({
      isCommercialImage: true,
      documentKind: ProductDocumentKind.OTHER,
    });
    expect(classifyOdooAttachment('ficha_tecnica.pdf', 'application/pdf')).toEqual({
      isCommercialImage: false,
      documentKind: ProductDocumentKind.DATASHEET,
    });
    expect(classifyOdooAttachment('Manual_Usuario.pdf', 'application/pdf')).toEqual({
      isCommercialImage: false,
      documentKind: ProductDocumentKind.MANUAL,
    });
    expect(classifyOdooAttachment('factura_proveedor.png', 'image/png')).toEqual({
      isCommercialImage: false,
      documentKind: ProductDocumentKind.INTERNAL,
    });
  });

  it('produces deterministic media keys and unit conversions', () => {
    const digest = sha256Hex(Buffer.from('sample-bytes'));
    expect(buildOdooMediaKey('doc', 1001, digest)).toBe(`odoo:doc:1001:${digest.slice(0, 16)}`);
    expect(formatOdooDecimal(12)).toBe('12.00');
    expect(formatOdooDecimal(4.505)).toBe('4.51');
    expect(kgToGrams(0.45)).toBe(450);
    expect(kgToGrams(0)).toBeNull();
  });
});
