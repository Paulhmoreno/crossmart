export const ODOO_SOURCE_PROVIDER = 'odoo';
export const ODOO_CREDENTIALS_CONTEXT = 'odoo-source-credentials';
export const ODOO_SYNC_JOB_NAME = 'sync-catalog';
export const ODOO_RPC_TIMEOUT_MS = 30_000;
export const ODOO_SYNC_JOB_ATTEMPTS = 3;
export const ODOO_SYNC_BACKOFF_MS = 5_000;
export const ODOO_DEFAULT_PREVIEW_LIMIT = 20;
export const ODOO_MAX_PREVIEW_LIMIT = 50;
export const ODOO_MAX_SYNC_ISSUES = 100;

/** Strictly enforced allowlist of Odoo ORM read-only methods. Writes are physically blocked. */
export const ODOO_READ_ONLY_METHODS: ReadonlySet<string> = new Set([
  'fields_get',
  'search',
  'search_read',
  'search_count',
  'read',
]);

export const ODOO_SUPPORTED_IMAGE_MIMETYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

export enum OdooStockField {
  FreeQty = 'free_qty',
  QtyAvailable = 'qty_available',
}
