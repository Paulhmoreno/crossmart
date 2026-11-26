import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  type MercadoLibreListingSetupInput,
  MercadoLibreShippingMode,
} from '@crossmart/connectors';
import { MERCADOLIBRE_SHIPPING_MODE_SCHEMA_NAME } from '../channels.constants.js';

const MAX_LISTING_TYPE_LENGTH = 64;
const MAX_WARRANTY_LENGTH = 80;

export class UpdateMercadoLibreListingSetupDto {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'gold_special',
    maxLength: MAX_LISTING_TYPE_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_LISTING_TYPE_LENGTH)
  defaultListingTypeId?: string | null;

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
      shippingMode: this.shippingMode ?? null,
      localPickUp: this.localPickUp ?? null,
      warrantyType: this.warrantyType?.trim() || null,
      warrantyTime: this.warrantyTime?.trim() || null,
      ...(typeof this.importOrders === 'boolean' ? { importOrders: this.importOrders } : {}),
    };
  }
}
