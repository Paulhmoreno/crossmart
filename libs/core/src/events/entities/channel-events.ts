/** A channel said one of a connection's orders changed (placed, edited, shipped, cancelled). */
export interface OrderChangedEvent {
  workspaceId: string;
  connectionId: string;
  externalOrderId: string;
}

/** A channel said one of a connection's listings changed remotely (status or moderation). */
export interface ListingChangedEvent {
  workspaceId: string;
  connectionId: string;
  externalListingId: string;
  topic: string;
}

/** Reacts to channel events, such as by reading the order or listing. Handlers must not throw. */
export interface ChannelEventListener {
  onOrderChanged?(event: OrderChangedEvent): Promise<void>;
  onListingChanged?(event: ListingChangedEvent): Promise<void>;
}
