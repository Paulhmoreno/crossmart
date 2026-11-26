import { ApiProperty } from '@nestjs/swagger';
import type {
  OrderDetail,
  OrderEventView,
  OrderLineView,
  OrderPage,
  OrderSummary,
} from '@crossmart/core';
import { OrderStatus } from '@crossmart/database';
import { ORDER_STATUS_SCHEMA_NAME } from '../orders.constants.js';

export class OrderSummaryDto implements OrderSummary {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: '#1001', description: 'The number the merchant and buyer see' })
  name: string;

  @ApiProperty({ enum: OrderStatus, enumName: ORDER_STATUS_SCHEMA_NAME })
  status: OrderStatus;

  @ApiProperty({ example: 'CONFIRMED' })
  commercialStatus: string;

  @ApiProperty({ example: 'PAID' })
  paymentStatus: string;

  @ApiProperty({ example: 'RESERVED' })
  reservationStatus: string;

  @ApiProperty({ example: 'PENDING' })
  logisticsStatus: string;

  @ApiProperty({ example: 'NOT_INVOICED' })
  invoicingStatus: string;

  @ApiProperty({ example: 'ESTIMATED' })
  financialStatus: string;

  @ApiProperty()
  manualInterventionRequired: boolean;

  @ApiProperty()
  manualReleaseLock: boolean;

  @ApiProperty({ type: String, nullable: true })
  erpOrderId: string | null;

  @ApiProperty({ type: String, nullable: true })
  erpOrderName: string | null;

  @ApiProperty({ type: String, nullable: true })
  erpInvoiceId: string | null;

  @ApiProperty({ type: String, nullable: true })
  erpInvoiceName: string | null;

  @ApiProperty()
  incidentCount: number;

  @ApiProperty({ example: 'USD' })
  currencyCode: string;

  @ApiProperty({ example: '130.00', description: 'What the buyer pays now' })
  total: string;

  @ApiProperty()
  placedAt: Date;

  @ApiProperty({ format: 'uuid' })
  connectionId: string;

  @ApiProperty({ example: 'Demo Store' })
  storeName: string;

  @ApiProperty({ example: 'shopify' })
  channel: string;

  @ApiProperty({ description: 'Units ordered, over every line' })
  itemCount: number;

  @ApiProperty({
    description: 'Lines that match no catalog variant, so their stock is not tracked',
  })
  unmatchedLines: number;

  static from(order: OrderSummary): OrderSummaryDto {
    return Object.assign(new OrderSummaryDto(), order);
  }
}

export class OrderEventDto implements OrderEventView {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  eventType: string;

  @ApiProperty()
  summary: string;

  @ApiProperty({ type: String, nullable: true })
  actorLabel: string | null;

  @ApiProperty({ type: Object })
  metadata: Record<string, unknown>;

  @ApiProperty()
  createdAt: Date;
}

export class OrderLineDto implements OrderLineView {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  title: string;

  @ApiProperty({ type: String, nullable: true })
  sku: string | null;

  @ApiProperty()
  quantity: number;

  @ApiProperty({ example: '45.00' })
  unitPrice: string;

  @ApiProperty({ description: 'Units held for the order until they ship' })
  reservedQuantity: number;

  @ApiProperty({ description: 'Units shipped' })
  fulfilledQuantity: number;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  variantId: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  productId: string | null;
}

export class OrderDetailDto extends OrderSummaryDto implements OrderDetail {
  @ApiProperty({ description: 'The order’s id on its channel' })
  externalId: string;

  @ApiProperty({ type: String, nullable: true })
  externalPackId: string | null;

  @ApiProperty({ type: String, nullable: true })
  manualReleaseReason: string | null;

  @ApiProperty({ type: Date, nullable: true })
  manualReleasedAt: Date | null;

  @ApiProperty({ type: Object, nullable: true })
  buyerInfo: Record<string, unknown> | null;

  @ApiProperty({ type: Object, nullable: true })
  fiscalInfo: Record<string, unknown> | null;

  @ApiProperty({ type: Object, nullable: true })
  shippingInfo: Record<string, unknown> | null;

  @ApiProperty({ type: Object, nullable: true })
  financialBreakdown: Record<string, unknown> | null;

  @ApiProperty({ type: Object, nullable: true })
  logisticsInfo: Record<string, unknown> | null;

  @ApiProperty({ type: [Object] })
  incidents: Array<Record<string, unknown>>;

  @ApiProperty({ type: [OrderEventDto] })
  events: OrderEventDto[];

  @ApiProperty({ type: [OrderLineDto] })
  lines: OrderLineDto[];

  static override from(order: OrderDetail): OrderDetailDto {
    return Object.assign(new OrderDetailDto(), order);
  }
}

export class OrderPageDto implements OrderPage {
  @ApiProperty({ type: [OrderSummaryDto] })
  items: OrderSummaryDto[];

  @ApiProperty({ type: String, nullable: true, description: 'Null on the last page' })
  nextCursor: string | null;

  @ApiProperty({ description: 'How many match in all, for page numbers' })
  total: number;

  static from(page: OrderPage): OrderPageDto {
    return Object.assign(new OrderPageDto(), {
      items: page.items.map((item) => OrderSummaryDto.from(item)),
      nextCursor: page.nextCursor,
      total: page.total,
    });
  }
}
