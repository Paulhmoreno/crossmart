import { Controller, Get, Param, ParseUUIDPipe, Res, StreamableFile } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { OdooConnectionService, WorkspacePermission } from '@crossmart/core';
import { WORKSPACE_ID_PARAM } from '../../auth/auth.constants.js';
import { RequirePermission } from '../../auth/decorators/require-permission.decorator.js';
import { PRODUCT_ID_PARAM } from '../../catalog/catalog.constants.js';
import { DOCUMENT_ID_PARAM, ODOO_TAG, PRODUCT_DOCUMENTS_ROUTE } from '../odoo.constants.js';

@ApiTags(ODOO_TAG)
@Controller(PRODUCT_DOCUMENTS_ROUTE)
export class ProductDocumentsController {
  constructor(private readonly odoo: OdooConnectionService) {}

  @Get(`:${DOCUMENT_ID_PARAM}/download`)
  @RequirePermission(WorkspacePermission.ViewProducts)
  @ApiExcludeEndpoint()
  async download(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Param(PRODUCT_ID_PARAM, ParseUUIDPipe) productId: string,
    @Param(DOCUMENT_ID_PARAM, ParseUUIDPipe) documentId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const file = await this.odoo.downloadProductDocument(workspaceId, productId, documentId);
    const safeName = file.name.replace(/["\r\n]/g, '_');
    response.setHeader('Content-Type', file.mimetype);
    response.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    response.setHeader('Cache-Control', 'private, no-store');
    return new StreamableFile(file.content);
  }
}
