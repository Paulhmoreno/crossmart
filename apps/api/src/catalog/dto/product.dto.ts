import { ApiProperty } from '@nestjs/swagger';
import type { MediaView, ProductDetail, ProductDocumentView, VariantView } from '@crossmart/core';
import {
  CatalogSourceKind,
  OutOfStockPolicy,
  ProductCondition,
  ProductDocumentKind,
  ProductStatus,
} from '@crossmart/database';
import {
  CATALOG_SOURCE_KIND_SCHEMA_NAME,
  OUT_OF_STOCK_POLICY_SCHEMA_NAME,
  PRODUCT_CONDITION_SCHEMA_NAME,
  PRODUCT_DOCUMENT_KIND_SCHEMA_NAME,
  PRODUCT_STATUS_SCHEMA_NAME,
} from '../catalog.constants.js';

export class VariantDto implements VariantView {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ type: String, nullable: true })
  sourceExternalId: string | null;

  @ApiProperty()
  position: number;

  @ApiProperty({ type: String, nullable: true })
  sku: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'GTIN, UPC, EAN or ISBN' })
  barcode: string | null;

  @ApiProperty({ type: [String], description: 'One value per product option, in order' })
  optionValues: string[];

  @ApiProperty({ example: '89.00', description: 'Decimal string in the workspace currency' })
  price: string;

  @ApiProperty({ type: String, nullable: true, example: '99.00' })
  compareAtPrice: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '40.00',
    description: 'What you pay per unit; never shown to buyers',
  })
  cost: string | null;

  @ApiProperty({ type: Number, nullable: true })
  weightGrams: number | null;

  @ApiProperty()
  requiresShipping: boolean;

  @ApiProperty()
  taxable: boolean;

  @ApiProperty({ enum: OutOfStockPolicy, enumName: OUT_OF_STOCK_POLICY_SCHEMA_NAME })
  outOfStockPolicy: OutOfStockPolicy;

  @ApiProperty({ description: 'Whether Crossmart tracks stock for this variant' })
  tracked: boolean;

  @ApiProperty()
  available: number;
}

export class MediaDto implements MediaView {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  url: string;

  @ApiProperty({ type: String, nullable: true })
  altText: string | null;

  @ApiProperty()
  position: number;

  @ApiProperty({
    description: 'True when synced from an authoritative source such as Odoo and protected',
  })
  sourceManaged: boolean;
}

export class ProductDocumentDto implements ProductDocumentView {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  sourceExternalId: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  mimetype: string;

  @ApiProperty({ type: Number, nullable: true })
  byteSize: number | null;

  @ApiProperty({ enum: ProductDocumentKind, enumName: PRODUCT_DOCUMENT_KIND_SCHEMA_NAME })
  kind: ProductDocumentKind;

  @ApiProperty()
  isPublic: boolean;

  @ApiProperty()
  createdAt: Date;
}

export class ProductDto implements ProductDetail {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  handle: string;

  @ApiProperty()
  title: string;

  @ApiProperty({ enum: CatalogSourceKind, enumName: CATALOG_SOURCE_KIND_SCHEMA_NAME })
  sourceKind: CatalogSourceKind;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  sourceConnectionId: string | null;

  @ApiProperty({ type: String, nullable: true })
  sourceExternalId: string | null;

  @ApiProperty({ type: Object, nullable: true })
  sourceMetadata: Record<string, unknown> | null;

  @ApiProperty()
  descriptionHtml: string;

  @ApiProperty({ type: String, nullable: true })
  vendor: string | null;

  @ApiProperty({ type: String, nullable: true })
  productType: string | null;

  @ApiProperty({ type: [String] })
  tags: string[];

  @ApiProperty({ enum: ProductStatus, enumName: PRODUCT_STATUS_SCHEMA_NAME })
  status: ProductStatus;

  @ApiProperty({
    enum: ProductCondition,
    enumName: PRODUCT_CONDITION_SCHEMA_NAME,
    nullable: true,
    description: 'The item’s condition; null lists it in each store’s default condition',
  })
  condition: ProductCondition | null;

  @ApiProperty({ type: [String], example: ['Size', 'Color'] })
  optionNames: string[];

  @ApiProperty({ type: [VariantDto] })
  variants: VariantDto[];

  @ApiProperty({ type: [MediaDto] })
  media: MediaDto[];

  @ApiProperty({ type: [ProductDocumentDto] })
  documents: ProductDocumentDto[];

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;

  static from(detail: ProductDetail): ProductDto {
    return Object.assign(new ProductDto(), {
      ...detail,
      variants: detail.variants.map((variant) => Object.assign(new VariantDto(), variant)),
      media: detail.media.map((media) => Object.assign(new MediaDto(), media)),
      documents: detail.documents.map((doc) => Object.assign(new ProductDocumentDto(), doc)),
    });
  }
}
