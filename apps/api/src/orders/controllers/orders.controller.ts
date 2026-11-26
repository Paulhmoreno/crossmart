import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type Actor,
  OrderOrchestrationService,
  OrdersService,
  WorkspacePermission,
} from '@crossmart/core';
import { WORKSPACE_ID_PARAM } from '../../auth/auth.constants.js';
import { CurrentActor } from '../../auth/decorators/current-actor.decorator.js';
import { RequirePermission } from '../../auth/decorators/require-permission.decorator.js';
import { ListOrdersQueryDto } from '../dto/list-orders-query.dto.js';
import { OrderDetailDto, OrderPageDto } from '../dto/order.dto.js';
import { ORDER_ID_PARAM, ORDER_PATH, ORDERS_ROUTE, ORDERS_TAG } from '../orders.constants.js';

@ApiTags(ORDERS_TAG)
@Controller(ORDERS_ROUTE)
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly orchestration: OrderOrchestrationService,
  ) {}

  @Get()
  @RequirePermission(WorkspacePermission.ViewOrders)
  @ApiOperation({
    summary: 'Orders from every connected store, newest first',
  })
  @ApiOkResponse({ type: OrderPageDto })
  async list(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Query() query: ListOrdersQueryDto,
  ): Promise<OrderPageDto> {
    return OrderPageDto.from(await this.orders.list(workspaceId, query));
  }

  @Get('summary/operational')
  @RequirePermission(WorkspacePermission.ViewOrders)
  @ApiOperation({ summary: 'Read-only operational summary of orders, reservations, and incidents' })
  async operationalSummary(@Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string) {
    return this.orchestration.getOperationalSummary(workspaceId);
  }

  @Get(ORDER_PATH)
  @RequirePermission(WorkspacePermission.ViewOrders)
  @ApiOperation({ summary: 'One order with its lines, independent statuses, financials, and audit trail' })
  @ApiOkResponse({ type: OrderDetailDto })
  async get(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Param(ORDER_ID_PARAM, ParseUUIDPipe) orderId: string,
  ): Promise<OrderDetailDto> {
    return OrderDetailDto.from(await this.orders.get(workspaceId, orderId));
  }

  @Post(`${ORDER_PATH}/release-reservation`)
  @RequirePermission(WorkspacePermission.ManageChannels)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Emergency manual release of reserved inventory with mandatory reason' })
  async releaseReservation(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Param(ORDER_ID_PARAM, ParseUUIDPipe) orderId: string,
    @Body() body: { reason: string; cancelErpOrder?: boolean },
    @CurrentActor() actor: Actor,
  ) {
    return this.orchestration.releaseReservation(workspaceId, orderId, body, actor);
  }

  @Post(`${ORDER_PATH}/re-reserve`)
  @RequirePermission(WorkspacePermission.ManageChannels)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Explicitly authorized re-reservation of order inventory' })
  async reReserve(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Param(ORDER_ID_PARAM, ParseUUIDPipe) orderId: string,
    @CurrentActor() actor: Actor,
  ) {
    return this.orchestration.reReserveOrder(workspaceId, orderId, actor);
  }

  @Post(`${ORDER_PATH}/invoice`)
  @RequirePermission(WorkspacePermission.ManageChannels)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Generate draft invoice (or post when explicitly authorized) in Odoo' })
  async generateInvoice(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Param(ORDER_ID_PARAM, ParseUUIDPipe) orderId: string,
    @Body() body: { post?: boolean },
    @CurrentActor() actor: Actor,
  ) {
    return this.orchestration.generateInvoice(workspaceId, orderId, body ?? {}, actor);
  }
}
