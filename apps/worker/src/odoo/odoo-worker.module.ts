import { Module } from '@nestjs/common';
import { OdooModule } from '@crossmart/core';
import { OdooSyncProcessor } from './odoo-sync.processor.js';

@Module({
  imports: [OdooModule],
  providers: [OdooSyncProcessor],
})
export class OdooWorkerModule {}
