import { Module } from '@nestjs/common';
import { OdooModule } from '@crossmart/core';
import { AuthModule } from '../auth/auth.module.js';
import { OdooEventsController } from './controllers/odoo-events.controller.js';
import { OdooSourceController } from './controllers/odoo-source.controller.js';
import { ProductDocumentsController } from './controllers/product-documents.controller.js';

@Module({
  imports: [AuthModule, OdooModule],
  controllers: [OdooSourceController, OdooEventsController, ProductDocumentsController],
})
export class OdooApiModule {}
