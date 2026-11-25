import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WOOCOMMERCE_CREDENTIALS_GUIDE_URL, WooCommercePublishStatus } from '@crossmart/connectors';
import { WOOCOMMERCE_PUBLISH_STATUS_SCHEMA_NAME } from '../channels.constants.js';

/**
 * What a WooCommerce merchant enters to connect their store. Secrets are sealed with
 * envelope encryption and never stored in settings, logged, or returned.
 */
export class WooCommerceCredentialsDto {
  @ApiProperty({
    example: 'https://tienda.ejemplo.com',
    description: `HTTPS URL of the WooCommerce store. See ${WOOCOMMERCE_CREDENTIALS_GUIDE_URL}`,
  })
  storeUrl: string;

  @ApiProperty({
    writeOnly: true,
    description:
      'WooCommerce REST API v3 Consumer Key (`ck_...`). Stored encrypted; never returned.',
  })
  consumerKey: string;

  @ApiProperty({
    writeOnly: true,
    description:
      'WooCommerce REST API v3 Consumer Secret (`cs_...`). Stored encrypted; never returned.',
  })
  consumerSecret: string;

  @ApiPropertyOptional({
    example: 'crossmart-media',
    description:
      'Optional WordPress username with upload_files capability for direct photo uploads from local storage.',
  })
  wpUsername?: string;

  @ApiPropertyOptional({
    writeOnly: true,
    description:
      'Optional WordPress Application Password paired with wpUsername. Stored encrypted; never returned.',
  })
  wpAppPassword?: string;

  @ApiPropertyOptional({
    enum: WooCommercePublishStatus,
    enumName: WOOCOMMERCE_PUBLISH_STATUS_SCHEMA_NAME,
    description: 'Default status for newly created products (`draft` recommended).',
  })
  defaultStatus?: WooCommercePublishStatus;
}
