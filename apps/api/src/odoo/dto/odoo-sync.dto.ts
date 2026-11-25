import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  ODOO_DEFAULT_PREVIEW_LIMIT,
  ODOO_MAX_PREVIEW_LIMIT,
  type OdooSyncFilterInput,
  type OdooSyncRequestInput,
} from '@crossmart/core';
import { OdooSyncMode } from '@crossmart/database';
import { ODOO_SYNC_MODE_SCHEMA_NAME } from '../odoo.constants.js';

const MIN_LIMIT = 1;
const MAX_SYNC_LIMIT = 5000;

export class OdooSyncFilterDto implements OdooSyncFilterInput {
  @ApiPropertyOptional({ type: [Number] })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  templateIds?: number[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  skus?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  barcodes?: string[];

  @ApiPropertyOptional({ type: [Number] })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  categoryIds?: number[];

  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @IsBoolean()
  saleOnly?: boolean;

  @ApiPropertyOptional({ type: Number })
  @IsOptional()
  @IsInt()
  @Min(MIN_LIMIT)
  @Max(MAX_SYNC_LIMIT)
  limit?: number;
}

export class StartOdooSyncDto implements OdooSyncRequestInput {
  @ApiProperty({ enum: OdooSyncMode, enumName: ODOO_SYNC_MODE_SCHEMA_NAME })
  @IsEnum(OdooSyncMode)
  mode: OdooSyncMode;

  @ApiPropertyOptional({ type: OdooSyncFilterDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => OdooSyncFilterDto)
  filter?: OdooSyncFilterDto;
}

export class PreviewOdooProductsQueryDto {
  @ApiPropertyOptional({ description: 'Search by name, SKU, or barcode' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    default: ODOO_DEFAULT_PREVIEW_LIMIT,
    minimum: MIN_LIMIT,
    maximum: ODOO_MAX_PREVIEW_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MIN_LIMIT)
  @Max(ODOO_MAX_PREVIEW_LIMIT)
  limit?: number;
}
