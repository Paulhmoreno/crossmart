import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  type MercadoLibreListingSetupInput,
  MercadoLibreShippingMode,
  MercadoLibreShippingPolicy,
} from '@crossmart/connectors';
import {
  MERCADOLIBRE_SHIPPING_MODE_SCHEMA_NAME,
  MERCADOLIBRE_SHIPPING_POLICY_SCHEMA_NAME,
} from '../channels.constants.js';

const MAX_LISTING_TYPE_LENGTH = 64;
const MAX_WARRANTY_LENGTH = 80;
const MAX_PERCENT = 100;

export class UpdateMercadoLibreListingSetupDto {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'bronze',
    maxLength: MAX_LISTING_TYPE_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_LISTING_TYPE_LENGTH)
  defaultListingTypeId?: string | null;

  @ApiPropertyOptional({
    enum: MercadoLibreShippingPolicy,
    enumName: MERCADOLIBRE_SHIPPING_POLICY_SCHEMA_NAME,
    nullable: true,
  })
  @IsOptional()
  @IsEnum(MercadoLibreShippingPolicy)
  shippingPolicy?: MercadoLibreShippingPolicy | null;

  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  autoFreeShippingMinPrice?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 0, maximum: MAX_PERCENT })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(MAX_PERCENT)
  autoFreeShippingMaxCostPercent?: number | null;

  @ApiPropertyOptional({
    enum: MercadoLibreShippingMode,
    enumName: MERCADOLIBRE_SHIPPING_MODE_SCHEMA_NAME,
    nullable: true,
  })
  @IsOptional()
  @IsEnum(MercadoLibreShippingMode)
  shippingMode?: MercadoLibreShippingMode | null;

  @ApiPropertyOptional({ type: Boolean, nullable: true })
  @IsOptional()
  @IsBoolean()
  localPickUp?: boolean | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: MAX_WARRANTY_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_WARRANTY_LENGTH)
  warrantyType?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: MAX_WARRANTY_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_WARRANTY_LENGTH)
  warrantyTime?: string | null;

  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @IsBoolean()
  importOrders?: boolean;

  toInput(): MercadoLibreListingSetupInput {
    return {
      defaultListingTypeId: this.defaultListingTypeId?.trim() || null,
      shippingPolicy: this.shippingPolicy ?? null,
      autoFreeShippingMinPrice:
        typeof this.autoFreeShippingMinPrice === 'number' ? this.autoFreeShippingMinPrice : null,
      autoFreeShippingMaxCostPercent:
        typeof this.autoFreeShippingMaxCostPercent === 'number'
          ? this.autoFreeShippingMaxCostPercent
          : null,
      shippingMode: this.shippingMode ?? null,
      localPickUp: this.localPickUp ?? null,
      warrantyType: this.warrantyType?.trim() || null,
      warrantyTime: this.warrantyTime?.trim() || null,
      ...(typeof this.importOrders === 'boolean' ? { importOrders: this.importOrders } : {}),
    };
  }
}
