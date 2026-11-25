import { ApiProperty } from '@nestjs/swagger';
import { WooCommercePublishStatus, type WooCommerceSettings } from '@crossmart/connectors';
import { WOOCOMMERCE_PUBLISH_STATUS_SCHEMA_NAME } from '../channels.constants.js';

/** Non-sensitive store details discovered from WooCommerce. Keys and passwords are never here. */
export class WooCommerceSettingsDto {
  @ApiProperty({ example: 'https://tienda.ejemplo.com' })
  storeUrl: string;

  @ApiProperty({ example: 'Mi Tienda' })
  storeName: string;

  @ApiProperty({ example: 'USD' })
  currencyCode: string;

  @ApiProperty()
  pricesIncludeTax: boolean;

  @ApiProperty({ example: 'kg' })
  weightUnit: string;

  @ApiProperty({ example: 'cm' })
  dimensionUnit: string;

  @ApiProperty({
    enum: WooCommercePublishStatus,
    enumName: WOOCOMMERCE_PUBLISH_STATUS_SCHEMA_NAME,
  })
  defaultStatus: WooCommercePublishStatus;

  @ApiProperty({
    description: 'True when WordPress Application Password credentials for media upload are active',
  })
  hasWordPressMediaAuth: boolean;

  @ApiProperty({ type: String, nullable: true })
  wpUsername: string | null;

  @ApiProperty({ type: Number, nullable: true })
  remoteProductCount: number | null;

  static from(settings: WooCommerceSettings): WooCommerceSettingsDto {
    const { channel: _channel, ...fields } = settings;
    return Object.assign(new WooCommerceSettingsDto(), fields);
  }
}
