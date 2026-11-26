import { ApiProperty } from '@nestjs/swagger';
import {
  type MercadoLibreListingTypeOption,
  type MercadoLibreSettings,
  MercadoLibreShippingMode,
  MercadoLibreShippingPolicy,
  MercadoLibreSiteId,
} from '@crossmart/connectors';
import {
  MERCADOLIBRE_SHIPPING_MODE_SCHEMA_NAME,
  MERCADOLIBRE_SHIPPING_POLICY_SCHEMA_NAME,
  MERCADOLIBRE_SITE_ID_SCHEMA_NAME,
} from '../channels.constants.js';

export class MercadoLibreListingTypeOptionDto {
  @ApiProperty({ example: 'gold_special' })
  id: string;

  @ApiProperty({ example: 'Clásica' })
  name: string;

  static from(option: MercadoLibreListingTypeOption): MercadoLibreListingTypeOptionDto {
    return Object.assign(new MercadoLibreListingTypeOptionDto(), {
      id: option.id,
      name: option.name,
    });
  }
}

/** What Crossmart read about the Mercado Libre seller and their commercial listing setup. */
export class MercadoLibreSettingsDto {
  @ApiProperty({ example: '1008002397', description: 'The seller’s Mercado Libre user id' })
  userId: string;

  @ApiProperty({ example: 'TESTSELLER' })
  nickname: string;

  @ApiProperty({
    enum: MercadoLibreSiteId,
    enumName: MERCADOLIBRE_SITE_ID_SCHEMA_NAME,
    description: 'The country site the seller sells on',
  })
  siteId: MercadoLibreSiteId;

  @ApiProperty({ example: 'USD', description: 'ISO 4217 code of the site’s currency' })
  currencyCode: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'https://perfil.mercadolibre.com.ec/TESTSELLER',
  })
  permalink: string | null;

  @ApiProperty({
    description:
      'Whether the seller lists under User Products: one item per variant, each with its own price',
  })
  userProductSeller: boolean;

  @ApiProperty({
    type: [MercadoLibreListingTypeOptionDto],
    description: 'Available listing types read from Mercado Libre for this site',
  })
  availableListingTypes: MercadoLibreListingTypeOptionDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'bronze',
    description: 'Default listing type id for new publications',
  })
  defaultListingTypeId: string | null;

  @ApiProperty({
    enum: MercadoLibreShippingPolicy,
    enumName: MERCADOLIBRE_SHIPPING_POLICY_SCHEMA_NAME,
    nullable: true,
    description: 'Commercial shipping policy: buyer pays, free shipping, or automatic',
  })
  shippingPolicy: MercadoLibreShippingPolicy | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Minimum listing price for automatic free shipping',
  })
  autoFreeShippingMinPrice: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Maximum acceptable shipping cost as percentage of sale price',
  })
  autoFreeShippingMaxCostPercent: number | null;

  @ApiProperty({
    enum: MercadoLibreShippingMode,
    enumName: MERCADOLIBRE_SHIPPING_MODE_SCHEMA_NAME,
    nullable: true,
    description: 'Internal shipping mode override; null lets Mercado Libre manage logistics',
  })
  shippingMode: MercadoLibreShippingMode | null;

  @ApiProperty({
    type: Boolean,
    nullable: true,
    description: 'Allow local pickup when supported by the site and category',
  })
  localPickUp: boolean | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Garantía del vendedor',
    description: 'Commercial warranty type sent in sale_terms when set',
  })
  warrantyType: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '6 meses',
    description: 'Commercial warranty duration sent in sale_terms when set',
  })
  warrantyTime: string | null;

  @ApiProperty({
    description: 'Whether orders from this Mercado Libre store are imported into Crossmart',
  })
  importOrders: boolean;

  static from(settings: MercadoLibreSettings): MercadoLibreSettingsDto {
    return Object.assign(new MercadoLibreSettingsDto(), {
      userId: settings.userId,
      nickname: settings.nickname,
      siteId: settings.siteId,
      currencyCode: settings.currencyCode,
      permalink: settings.permalink,
      userProductSeller: settings.userProductSeller,
      availableListingTypes: (settings.availableListingTypes ?? []).map((option) =>
        MercadoLibreListingTypeOptionDto.from(option),
      ),
      defaultListingTypeId: settings.defaultListingTypeId ?? null,
      shippingPolicy: settings.shippingPolicy ?? null,
      autoFreeShippingMinPrice: settings.autoFreeShippingMinPrice ?? null,
      autoFreeShippingMaxCostPercent: settings.autoFreeShippingMaxCostPercent ?? null,
      shippingMode: settings.shippingMode ?? null,
      localPickUp: settings.localPickUp ?? null,
      warrantyType: settings.warrantyType ?? null,
      warrantyTime: settings.warrantyTime ?? null,
      importOrders: settings.importOrders ?? false,
    });
  }
}
