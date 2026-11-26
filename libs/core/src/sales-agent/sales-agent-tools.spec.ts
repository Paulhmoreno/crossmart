import { describe, expect, it } from 'vitest';
import { expandSearchTokens } from './sales-agent-tools.service.js';
import { extractNormalizedChatwootContext } from './sales-agent.service.js';
import { normalizeChannelSlug, normalizeKnowledgeScope } from './sales-knowledge.service.js';

describe('SalesAgent catalog search and channel context normalization', () => {
  it('expands Spanish plural and accented tokens so tocadiscos matches tocadisco', () => {
    const tokens = expandSearchTokens('tocadiscos de maletín');
    expect(tokens).toContain('tocadiscos');
    expect(tokens).toContain('tocadisco');
    expect(tokens).toContain('maletin');
  });

  it('extracts normalized channel and product context from Chatwoot webhooks', () => {
    const ctx = extractNormalizedChatwootContext({
      id: 42,
      inbox: { id: 2, name: 'Elektrofertas', channel_type: 'Channel::FacebookPage' },
      sender: { id: 10, name: 'María' },
      conversation: {
        id: 101,
        inbox_id: 2,
        custom_attributes: { listing_id: 'MEC-12345', sku: '1231' },
        additional_attributes: { product_title: 'TOCADISCO DE MALETÍN' },
      },
    });
    expect(ctx.channelType).toBe('Channel::FacebookPage');
    expect(ctx.channelSlug).toBe('messenger');
    expect(ctx.inboxId).toBe(2);
    expect(ctx.listingId).toBe('MEC-12345');
    expect(ctx.sku).toBe('1231');
    expect(ctx.productRef).toBe('TOCADISCO DE MALETÍN');
    expect(ctx.contactName).toBe('María');
  });

  it('normalizes knowledge scopes across global and per-channel targets', () => {
    expect(normalizeKnowledgeScope('global')).toBe('global');
    expect(normalizeKnowledgeScope('marketplace')).toBe('channel:marketplace');
    expect(normalizeKnowledgeScope('Channel::WebWidget')).toBe('channel:web_widget');
    expect(normalizeChannelSlug('Channel::Whatsapp')).toBe('whatsapp');
  });
});
