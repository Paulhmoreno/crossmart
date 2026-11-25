import { createHash } from 'node:crypto';
import { ProductDocumentKind } from '@crossmart/database';
import { ODOO_SUPPORTED_IMAGE_MIMETYPES } from '../odoo.constants.js';

const DATASHEET_PATTERN = /ficha|datasheet|spec|especificaci|tecnic|technical|catalog/i;
const MANUAL_PATTERN = /manual|guia|guide|instrucc|user.?guide|handbook|quickstart/i;
const INTERNAL_PATTERN = /interno|internal|cost|precio|factura|invoice|proveedor|supplier|confid/i;

const MEDIA_HASH_PREFIX_LENGTH = 16;
const DECIMAL_PLACES = 2;
const CENTS_FACTOR = 100;
const GRAMS_PER_KILOGRAM = 1000;

export interface ClassifiedAttachment {
  isCommercialImage: boolean;
  documentKind: ProductDocumentKind;
}

/**
 * Classifies an Odoo `product.document` / `ir.attachment` entry:
 * - Supported raster images (JPEG, PNG, WebP, GIF) without internal-file names are eligible
 *   as commercial photos copied through Crossmart's native media pipeline.
 * - Non-image files (PDFs, Office docs, etc.) are classified as private reference documents
 *   and never auto-published as storefront product images.
 */
export function classifyOdooAttachment(name: string, mimetype: string): ClassifiedAttachment {
  const normalizedMime = mimetype.trim().toLowerCase();
  if (ODOO_SUPPORTED_IMAGE_MIMETYPES.has(normalizedMime) && !INTERNAL_PATTERN.test(name)) {
    return { isCommercialImage: true, documentKind: ProductDocumentKind.OTHER };
  }
  if (INTERNAL_PATTERN.test(name)) {
    return { isCommercialImage: false, documentKind: ProductDocumentKind.INTERNAL };
  }
  if (MANUAL_PATTERN.test(name)) {
    return { isCommercialImage: false, documentKind: ProductDocumentKind.MANUAL };
  }
  if (DATASHEET_PATTERN.test(name)) {
    return { isCommercialImage: false, documentKind: ProductDocumentKind.DATASHEET };
  }
  if (normalizedMime === 'application/pdf') {
    return { isCommercialImage: false, documentKind: ProductDocumentKind.DATASHEET };
  }
  return { isCommercialImage: false, documentKind: ProductDocumentKind.INTERNAL };
}

export function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export function buildOdooMediaKey(
  prefix: string,
  externalId: string | number,
  hash: string,
): string {
  return `odoo:${prefix}:${externalId}:${hash.slice(0, MEDIA_HASH_PREFIX_LENGTH)}`;
}

export function formatOdooDecimal(value: number | null | undefined): string {
  const numeric = typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
  const rounded = Math.round((numeric + Number.EPSILON) * CENTS_FACTOR) / CENTS_FACTOR;
  return rounded.toFixed(DECIMAL_PLACES);
}

export function kgToGrams(weightKg: number | null | undefined): number | null {
  if (typeof weightKg !== 'number' || !Number.isFinite(weightKg) || weightKg <= 0) return null;
  return Math.round(weightKg * GRAMS_PER_KILOGRAM);
}
