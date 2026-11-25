import { createHash } from 'node:crypto';
import { ProductDocumentKind } from '@crossmart/database';
import { ODOO_SUPPORTED_IMAGE_MIMETYPES } from '../odoo.constants.js';

const DATASHEET_PATTERN = /ficha|datasheet|spec|especificaci|tecnic|technical|catalog/i;
const MANUAL_PATTERN = /manual|guia|guide|instrucc|user.?guide|handbook|quickstart/i;
const INTERNAL_PATTERN =
  /interno|internal|cost|costo|precio|lista.?precio|factura|invoice|recibo|receipt|comprobante|boleta|proforma|cotizaci|quote|presupuesto|proveedor|supplier|vendor|compra|purchase|orden.?compra|pedido|bodega|almacen|warehouse|inventario|guia.?remision|despacho|etiqueta|confid|privad|private|secret|contrato|contract|cedul|ruc|sri|retencion|nota.?venta|nota.?credito|captura|screenshot|screen.?shot|whatsapp|pago|transferencia|deposito|banco|cheque/i;

const MEDIA_HASH_PREFIX_LENGTH = 16;
const DECIMAL_PLACES = 2;
const CENTS_FACTOR = 100;
const GRAMS_PER_KILOGRAM = 1000;

export interface ClassifiedAttachment {
  isCommercialImage: boolean;
  documentKind: ProductDocumentKind;
}

export interface AttachmentClassificationContext {
  /** True only when the file is registered in Odoo's `product.document` relation (not a loose chatter attachment). */
  fromProductDocument: boolean;
  /** Value of Odoo's `product.document.attached_on_sale` field when present. */
  attachedOnSale?: string | null;
}

/**
 * Classifies an Odoo `product.document` / `ir.attachment` entry conservatively:
 * - Any file whose name matches internal/confidential, manual, or datasheet patterns is ALWAYS
 *   kept private (even when stored as an image) and never added to the commercial gallery.
 * - Loose `ir.attachment` rows not registered in `product.document` are kept private (`INTERNAL`).
 * - Quote-embedded `product.document` files (`attached_on_sale = 'inside'`) stay private (`DATASHEET`).
 * - Only supported raster images explicitly registered in `product.document` without sensitive/technical
 *   names are eligible for Crossmart's commercial gallery.
 */
export function classifyOdooAttachment(
  name: string,
  mimetype: string,
  context: AttachmentClassificationContext = { fromProductDocument: false },
): ClassifiedAttachment {
  const normalizedMime = mimetype.trim().toLowerCase();
  if (INTERNAL_PATTERN.test(name)) {
    return { isCommercialImage: false, documentKind: ProductDocumentKind.INTERNAL };
  }
  if (MANUAL_PATTERN.test(name)) {
    return { isCommercialImage: false, documentKind: ProductDocumentKind.MANUAL };
  }
  if (DATASHEET_PATTERN.test(name)) {
    return { isCommercialImage: false, documentKind: ProductDocumentKind.DATASHEET };
  }
  if (!context.fromProductDocument) {
    return {
      isCommercialImage: false,
      documentKind:
        normalizedMime === 'application/pdf'
          ? ProductDocumentKind.DATASHEET
          : ProductDocumentKind.INTERNAL,
    };
  }
  if (context.attachedOnSale === 'inside') {
    return { isCommercialImage: false, documentKind: ProductDocumentKind.DATASHEET };
  }
  if (ODOO_SUPPORTED_IMAGE_MIMETYPES.has(normalizedMime)) {
    return { isCommercialImage: true, documentKind: ProductDocumentKind.OTHER };
  }
  if (normalizedMime === 'application/pdf') {
    return { isCommercialImage: false, documentKind: ProductDocumentKind.DATASHEET };
  }
  return { isCommercialImage: false, documentKind: ProductDocumentKind.INTERNAL };
}

/**
 * Canonical origin fingerprint `(normalized URL + database)` used to prevent mixing
 * product external IDs from different Odoo instances or databases.
 */
export function buildOdooSourceOrigin(rawUrl: string, database: string): string {
  const trimmedUrl = rawUrl.trim().replace(/\/+$/, '');
  const parsed = new URL(trimmedUrl);
  const normalizedPath = parsed.pathname.replace(/\/+$/, '');
  const normalizedOrigin = `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${normalizedPath}`;
  const normalizedDb = database.trim().toLowerCase();
  return `${normalizedOrigin}#${normalizedDb}`;
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
