import { describeError } from '@crossmart/common';
import { Injectable, Logger } from '@nestjs/common';
import type {
  ChannelEventListener,
  ListingChangedEvent,
  OrderChangedEvent,
} from '../entities/channel-events.js';

/**
 * Tells interested modules what channels reported, so the channels module that receives
 * webhooks need not know who handles them (orders, listings). Publishing never throws.
 */
@Injectable()
export class ChannelEventBus {
  private readonly logger = new Logger(ChannelEventBus.name);
  private readonly listeners: ChannelEventListener[] = [];

  subscribe(listener: ChannelEventListener): void {
    this.listeners.push(listener);
  }

  async orderChanged(event: OrderChangedEvent): Promise<void> {
    for (const listener of this.listeners) {
      if (!listener.onOrderChanged) continue;
      try {
        await listener.onOrderChanged(event);
      } catch (error) {
        const reason = describeError(error);
        this.logger.error(`A channel listener failed in workspace ${event.workspaceId}: ${reason}`);
      }
    }
  }

  async listingChanged(event: ListingChangedEvent): Promise<void> {
    for (const listener of this.listeners) {
      if (!listener.onListingChanged) continue;
      try {
        await listener.onListingChanged(event);
      } catch (error) {
        const reason = describeError(error);
        this.logger.error(`A listing listener failed in workspace ${event.workspaceId}: ${reason}`);
      }
    }
  }
}
