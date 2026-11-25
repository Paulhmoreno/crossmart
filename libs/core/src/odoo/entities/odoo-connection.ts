import type { OdooConnectionStatus, OdooSyncMode, OdooSyncRunStatus } from '@crossmart/database';
import type { OdooStockField } from '../odoo.constants.js';

export interface OdooCredentialsInput {
  url: string;
  database: string;
  username: string;
  apiKey: string;
}

export interface OdooSealedSecret {
  apiKey: string;
}

export interface OdooWarehouseOption {
  id: number;
  name: string;
  code: string;
}

export interface OdooPricelistOption {
  id: number;
  name: string;
  currency: string | null;
}

export interface OdooCategoryOption {
  id: number;
  name: string;
}

export interface OdooDiscoveredCapabilities {
  serverVersion: string;
  companyName: string | null;
  currency: string;
  productCount: number;
  warehouses: OdooWarehouseOption[];
  pricelists: OdooPricelistOption[];
  categories: OdooCategoryOption[];
  brandField: string | null;
  hasProductDocuments: boolean;
  hasProductImages: boolean;
}

export interface OdooAdvancedSettings {
  warehouseId?: number | null;
  pricelistId?: number | null;
  stockField?: OdooStockField;
  brandField?: string | null;
  customFields?: string[];
  filterCategoryIds?: number[];
  filterSaleOnly?: boolean;
  syncIntervalMinutes?: number | null;
}

export interface OdooStoredSettings extends OdooAdvancedSettings {
  discovered?: OdooDiscoveredCapabilities;
}

export interface OdooTestConnectionResult {
  ok: boolean;
  error: string | null;
  discovered: OdooDiscoveredCapabilities | null;
}

export interface OdooSyncIssue {
  externalId: string;
  name: string;
  message: string;
}

export interface OdooSyncRunView {
  id: string;
  connectionId: string;
  mode: OdooSyncMode;
  status: OdooSyncRunStatus;
  totalCount: number;
  processedCount: number;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  failedCount: number;
  errorMessage: string | null;
  issues: OdooSyncIssue[];
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}

export interface OdooConnectionView {
  id: string;
  displayName: string;
  url: string;
  database: string;
  username: string;
  hasCredentials: boolean;
  status: OdooConnectionStatus;
  statusReason: string | null;
  settings: OdooAdvancedSettings;
  discovered: OdooDiscoveredCapabilities | null;
  syncedProductCount: number;
  lastTestedAt: Date | null;
  lastSyncedAt: Date | null;
  connectedAt: Date;
  disconnectedAt: Date | null;
  latestRun: OdooSyncRunView | null;
  recentRuns: OdooSyncRunView[];
}

export interface OdooPreviewProduct {
  templateId: number;
  name: string;
  sku: string | null;
  barcode: string | null;
  brand: string | null;
  category: string | null;
  listPrice: string;
  qtyAvailable: number;
  variantCount: number;
  documentCount: number;
  hasMainImage: boolean;
  alreadySynced: boolean;
  crossmartProductId: string | null;
}

export interface OdooSyncFilterInput {
  templateIds?: number[];
  skus?: string[];
  barcodes?: string[];
  categoryIds?: number[];
  saleOnly?: boolean;
  limit?: number;
}

export interface OdooSyncRequestInput {
  mode: OdooSyncMode;
  filter?: OdooSyncFilterInput;
}

export interface OdooSyncJobRef {
  workspaceId: string;
  runId: string;
}
