import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  type OdooAdvancedSettings,
  type OdooCategoryOption,
  type OdooConnectionView,
  type OdooDiscoveredCapabilities,
  type OdooPreviewProduct,
  type OdooPricelistOption,
  OdooStockField,
  type OdooSyncIssue,
  type OdooSyncRunView,
  type OdooTestConnectionResult,
  type OdooWarehouseOption,
} from '@crossmart/core';
import { OdooConnectionStatus, OdooSyncMode, OdooSyncRunStatus } from '@crossmart/database';
import {
  ODOO_CONNECTION_STATUS_SCHEMA_NAME,
  ODOO_STOCK_FIELD_SCHEMA_NAME,
  ODOO_SYNC_MODE_SCHEMA_NAME,
  ODOO_SYNC_RUN_STATUS_SCHEMA_NAME,
} from '../odoo.constants.js';

const MIN_SYNC_INTERVAL_MINUTES = 5;
const MAX_SYNC_INTERVAL_MINUTES = 1440;

export class OdooAdvancedSettingsDto implements OdooAdvancedSettings {
  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional()
  @IsInt()
  warehouseId?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional()
  @IsInt()
  pricelistId?: number | null;

  @ApiPropertyOptional({ enum: OdooStockField, enumName: ODOO_STOCK_FIELD_SCHEMA_NAME })
  @IsOptional()
  @IsEnum(OdooStockField)
  stockField?: OdooStockField;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  brandField?: string | null;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  customFields?: string[];

  @ApiPropertyOptional({ type: [Number] })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  filterCategoryIds?: number[];

  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @IsBoolean()
  filterSaleOnly?: boolean;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(MIN_SYNC_INTERVAL_MINUTES)
  @Max(MAX_SYNC_INTERVAL_MINUTES)
  syncIntervalMinutes?: number | null;
}

export class TestOdooConnectionDto {
  @ApiPropertyOptional({ example: 'https://erp.example.com' })
  @IsOptional()
  @IsUrl({ require_tld: false, require_protocol: true })
  url?: string;

  @ApiPropertyOptional({ example: 'my_company_db' })
  @IsOptional()
  @IsString()
  database?: string;

  @ApiPropertyOptional({ example: 'sync@example.com' })
  @IsOptional()
  @IsString()
  username?: string;

  @ApiPropertyOptional({ description: 'Odoo API key (omit to test stored credentials)' })
  @IsOptional()
  @IsString()
  apiKey?: string;
}

export class UpsertOdooConnectionDto {
  @ApiProperty({ example: 'https://erp.example.com' })
  @IsUrl({ require_tld: false, require_protocol: true })
  url: string;

  @ApiProperty({ example: 'my_company_db' })
  @IsString()
  database: string;

  @ApiProperty({ example: 'sync@example.com' })
  @IsString()
  username: string;

  @ApiPropertyOptional({
    description: 'Odoo API key (required on first connect; optional when updating settings)',
  })
  @IsOptional()
  @IsString()
  apiKey?: string;

  @ApiPropertyOptional({ example: 'Odoo Principal' })
  @IsOptional()
  @IsString()
  displayName?: string;

  @ApiPropertyOptional({ type: OdooAdvancedSettingsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => OdooAdvancedSettingsDto)
  settings?: OdooAdvancedSettingsDto;
}

export class OdooWarehouseOptionDto implements OdooWarehouseOption {
  @ApiProperty()
  id: number;

  @ApiProperty()
  name: string;

  @ApiProperty()
  code: string;
}

export class OdooPricelistOptionDto implements OdooPricelistOption {
  @ApiProperty()
  id: number;

  @ApiProperty()
  name: string;

  @ApiProperty({ type: String, nullable: true })
  currency: string | null;
}

export class OdooCategoryOptionDto implements OdooCategoryOption {
  @ApiProperty()
  id: number;

  @ApiProperty()
  name: string;
}

export class OdooDiscoveredCapabilitiesDto implements OdooDiscoveredCapabilities {
  @ApiProperty()
  serverVersion: string;

  @ApiProperty({ type: String, nullable: true })
  companyName: string | null;

  @ApiProperty()
  currency: string;

  @ApiProperty()
  productCount: number;

  @ApiProperty({ type: [OdooWarehouseOptionDto] })
  warehouses: OdooWarehouseOptionDto[];

  @ApiProperty({ type: [OdooPricelistOptionDto] })
  pricelists: OdooPricelistOptionDto[];

  @ApiProperty({ type: [OdooCategoryOptionDto] })
  categories: OdooCategoryOptionDto[];

  @ApiProperty({ type: String, nullable: true })
  brandField: string | null;

  @ApiProperty()
  hasProductDocuments: boolean;

  @ApiProperty()
  hasProductImages: boolean;
}

export class OdooTestConnectionResponseDto implements OdooTestConnectionResult {
  @ApiProperty()
  ok: boolean;

  @ApiProperty({ type: String, nullable: true })
  error: string | null;

  @ApiProperty({ type: OdooDiscoveredCapabilitiesDto, nullable: true })
  discovered: OdooDiscoveredCapabilitiesDto | null;
}

export class OdooSyncIssueDto implements OdooSyncIssue {
  @ApiProperty()
  externalId: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  message: string;
}

export class OdooSyncRunDto implements OdooSyncRunView {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  connectionId: string;

  @ApiProperty({ enum: OdooSyncMode, enumName: ODOO_SYNC_MODE_SCHEMA_NAME })
  mode: OdooSyncMode;

  @ApiProperty({ enum: OdooSyncRunStatus, enumName: ODOO_SYNC_RUN_STATUS_SCHEMA_NAME })
  status: OdooSyncRunStatus;

  @ApiProperty()
  totalCount: number;

  @ApiProperty()
  processedCount: number;

  @ApiProperty()
  createdCount: number;

  @ApiProperty()
  updatedCount: number;

  @ApiProperty()
  skippedCount: number;

  @ApiProperty()
  failedCount: number;

  @ApiProperty({ type: String, nullable: true })
  errorMessage: string | null;

  @ApiProperty({ type: [OdooSyncIssueDto] })
  issues: OdooSyncIssueDto[];

  @ApiProperty({ type: Date, nullable: true })
  startedAt: Date | null;

  @ApiProperty({ type: Date, nullable: true })
  finishedAt: Date | null;

  @ApiProperty()
  createdAt: Date;

  static from(view: OdooSyncRunView): OdooSyncRunDto {
    return Object.assign(new OdooSyncRunDto(), view);
  }
}

export class OdooConnectionDto implements OdooConnectionView {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  displayName: string;

  @ApiProperty()
  url: string;

  @ApiProperty()
  database: string;

  @ApiProperty()
  username: string;

  @ApiProperty()
  hasCredentials: boolean;

  @ApiProperty({ enum: OdooConnectionStatus, enumName: ODOO_CONNECTION_STATUS_SCHEMA_NAME })
  status: OdooConnectionStatus;

  @ApiProperty({ type: String, nullable: true })
  statusReason: string | null;

  @ApiProperty({ type: OdooAdvancedSettingsDto })
  settings: OdooAdvancedSettingsDto;

  @ApiProperty({ type: OdooDiscoveredCapabilitiesDto, nullable: true })
  discovered: OdooDiscoveredCapabilitiesDto | null;

  @ApiProperty()
  syncedProductCount: number;

  @ApiProperty({ type: Date, nullable: true })
  lastTestedAt: Date | null;

  @ApiProperty({ type: Date, nullable: true })
  lastSyncedAt: Date | null;

  @ApiProperty()
  connectedAt: Date;

  @ApiProperty({ type: Date, nullable: true })
  disconnectedAt: Date | null;

  @ApiProperty({ type: OdooSyncRunDto, nullable: true })
  latestRun: OdooSyncRunDto | null;

  @ApiProperty({ type: [OdooSyncRunDto] })
  recentRuns: OdooSyncRunDto[];

  static from(view: OdooConnectionView): OdooConnectionDto {
    return Object.assign(new OdooConnectionDto(), view);
  }
}

export class OdooConnectionStateDto {
  @ApiProperty({ type: OdooConnectionDto, nullable: true })
  connection: OdooConnectionDto | null;

  static from(view: OdooConnectionView | null): OdooConnectionStateDto {
    return Object.assign(new OdooConnectionStateDto(), {
      connection: view ? OdooConnectionDto.from(view) : null,
    });
  }
}

export class OdooPreviewProductDto implements OdooPreviewProduct {
  @ApiProperty()
  templateId: number;

  @ApiProperty()
  name: string;

  @ApiProperty({ type: String, nullable: true })
  sku: string | null;

  @ApiProperty({ type: String, nullable: true })
  barcode: string | null;

  @ApiProperty({ type: String, nullable: true })
  brand: string | null;

  @ApiProperty({ type: String, nullable: true })
  category: string | null;

  @ApiProperty()
  listPrice: string;

  @ApiProperty()
  qtyAvailable: number;

  @ApiProperty()
  variantCount: number;

  @ApiProperty()
  documentCount: number;

  @ApiProperty()
  hasMainImage: boolean;

  @ApiProperty()
  alreadySynced: boolean;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  crossmartProductId: string | null;
}

export class OdooPreviewResponseDto {
  @ApiProperty({ type: [OdooPreviewProductDto] })
  items: OdooPreviewProductDto[];
}
