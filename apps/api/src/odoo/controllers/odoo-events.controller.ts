import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  OdooEventIngestionService,
  type OdooEventBatchInput,
  type OdooEventBatchResult,
} from '@crossmart/core';
import { Public } from '../../auth/decorators/public.decorator.js';
import { ODOO_TAG } from '../odoo.constants.js';

function headerStr(req: Request, name: string): string {
  const val = req.headers[name];
  return typeof val === 'string' ? val : '';
}

@ApiTags(ODOO_TAG)
@Controller('odoo/events')
export class OdooEventsController {
  constructor(private readonly ingestion: OdooEventIngestionService) {}

  @Post('ping')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify HMAC-authenticated connectivity from Odoo crossmart_connector' })
  ping(
    @Req() req: Request & { rawBody?: Buffer },
    @Body() body: unknown,
  ): Promise<{ ok: true; connectionId: string }> {
    const rawBody = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(body ?? {});
    return this.ingestion.handlePing(
      headerStr(req, 'x-crossmart-connection-id'),
      headerStr(req, 'x-crossmart-timestamp'),
      headerStr(req, 'x-crossmart-signature'),
      rawBody,
    );
  }

  @Post()
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Receive batched Transactional Outbox events from Odoo crossmart_connector' })
  receive(
    @Req() req: Request & { rawBody?: Buffer },
    @Body() body: OdooEventBatchInput,
  ): Promise<OdooEventBatchResult> {
    const rawBody = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(body ?? {});
    return this.ingestion.ingestBatch(
      headerStr(req, 'x-crossmart-connection-id'),
      headerStr(req, 'x-crossmart-timestamp'),
      headerStr(req, 'x-crossmart-signature'),
      rawBody,
      body,
    );
  }
}
