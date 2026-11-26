import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type ChatwootWebhookOutcome,
  type ChatwootWebhookPayload,
  SalesAgentService,
} from '@crossmart/core';
import { Public } from '../auth/decorators/public.decorator.js';

@ApiTags('Communication')
@Controller('webhooks/chatwoot')
export class ChatwootWebhookController {
  constructor(private readonly salesAgent: SalesAgentService) {}

  @Post(':connectionId')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Receive Chatwoot AgentBot / webhook events for a specific connection',
  })
  receive(
    @Param('connectionId', ParseUUIDPipe) connectionId: string,
    @Body() payload: ChatwootWebhookPayload,
    @Headers('x-chatwoot-secret') headerSecret?: string,
    @Query('secret') querySecret?: string,
  ): Promise<ChatwootWebhookOutcome> {
    return this.salesAgent.handleChatwootWebhook(
      connectionId,
      payload,
      headerSecret ?? querySecret ?? null,
    );
  }
}
