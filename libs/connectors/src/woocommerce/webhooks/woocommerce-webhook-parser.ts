import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  type ChannelWebhookEvent,
  ChannelWebhookKind,
  type IncomingWebhook,
} from '../../sdk/capabilities/webhook-receiver.js';

const SIGNATURE_HEADER = 'x-wc-webhook-signature';
const TOPIC_HEADER = 'x-wc-webhook-topic';
const SOURCE_HEADER = 'x-wc-webhook-source';
const DELIVERY_ID_HEADER = 'x-wc-webhook-delivery-id';

const ORDER_TOPICS = new Set(['order.created', 'order.updated', 'order.deleted', 'order.restored']);

function computeWooSignature(secret: string, rawBody: Buffer): string {
  return createHmac('sha256', secret).update(rawBody).digest('base64');
}

function safeEqualBase64(expected: string, actual: string): boolean {
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(actual, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function externalAccountFromSource(sourceUrl: string | undefined): string {
  if (!sourceUrl) return '';
  try {
    const parsed = new URL(sourceUrl.trim());
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.host.toLowerCase()}${path}`;
  } catch {
    return '';
  }
}

/**
 * Verifies WooCommerce signed webhooks (`X-WC-Webhook-Signature` = base64 HMAC-SHA256 over raw body)
 * and maps order topics to Crossmart's channel-neutral `ChannelWebhookEvent`.
 * Note: intentionally NOT registered live or declared in `capabilities` during Phase 2.
 */
export function verifyWooCommerceWebhook(
  webhook: IncomingWebhook,
  secret: string,
): ChannelWebhookEvent | null {
  const signature = webhook.headers[SIGNATURE_HEADER]?.trim();
  const topic = webhook.headers[TOPIC_HEADER]?.trim() ?? '';
  if (!secret || !signature || !topic) return null;

  const expected = computeWooSignature(secret, webhook.rawBody);
  if (!safeEqualBase64(expected, signature)) return null;

  let payload: unknown = null;
  try {
    payload = webhook.rawBody.byteLength > 0 ? JSON.parse(webhook.rawBody.toString('utf8')) : null;
  } catch {
    return null;
  }

  const externalAccountId = externalAccountFromSource(webhook.headers[SOURCE_HEADER]);
  const deliveryId = webhook.headers[DELIVERY_ID_HEADER]?.trim() || null;
  const resourceId =
    payload && typeof payload === 'object' && 'id' in payload && payload.id !== undefined
      ? String((payload as { id: unknown }).id)
      : undefined;

  return {
    kind: ORDER_TOPICS.has(topic) ? ChannelWebhookKind.OrderChanged : ChannelWebhookKind.Unhandled,
    topic,
    externalAccountId,
    deliveryId,
    payload,
    resourceId,
  };
}
