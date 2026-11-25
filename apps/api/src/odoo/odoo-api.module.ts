import { Module } from '@nestjs/common';
import { OdooModule } from '@crossmart/core';
import { AuthModule } from '../auth/auth.module.js';
import { OdooSourceController } from './controllers/odoo-source.controller.js';
import { ProductDocumentsController } from './controllers/product-documents.controller.js';

@Module({
  imports: [AuthModule, OdooModule],
  controllers: [OdooSourceController, ProductDocumentsController],
})
export class OdooApiModule {}
