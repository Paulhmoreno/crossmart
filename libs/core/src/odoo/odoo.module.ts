import { Module } from '@nestjs/common';
import { ActivityModule } from '../activity/activity.module.js';
import { CredentialsModule } from '../credentials/credentials.module.js';
import { EventsModule } from '../events/events.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { MediaModule } from '../media/media.module.js';
import { OdooReadOnlyClient } from './client/odoo-readonly.client.js';
import { BullOdooSyncQueue, OdooSyncQueue } from './queue/odoo-sync.queue.js';
import { OdooConnectionService } from './services/odoo-connection.service.js';
import { OdooCredentialsVault } from './services/odoo-credentials.vault.js';
import { OdooSyncService } from './services/odoo-sync.service.js';

@Module({
  imports: [ActivityModule, CredentialsModule, EventsModule, InventoryModule, MediaModule],
  providers: [
    OdooReadOnlyClient,
    OdooCredentialsVault,
    { provide: OdooSyncQueue, useClass: BullOdooSyncQueue },
    OdooConnectionService,
    OdooSyncService,
  ],
  exports: [OdooReadOnlyClient, OdooConnectionService, OdooSyncService, OdooSyncQueue],
})
export class OdooModule {}
