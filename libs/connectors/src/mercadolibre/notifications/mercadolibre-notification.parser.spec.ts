import { ChannelWebhookKind } from '../../sdk/capabilities/webhook-receiver.js';
import { loadFixture } from '../../sdk/testing/fixtures.js';
import { createMercadoLibreTestKit, FIXTURES, fixtureJson } from '../mercadolibre.fixtures.js';
import { MercadoLibreApp } from '../mercadolibre-app.js';

function webhook(body: unknown) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return { rawBody: Buffer.from(raw), headers: { 'content-type': 'application/json' } };
}

describe('Mercado Libre notifications', () => {
  it('reads an orders_v2 notification as the order to read again', () => {
    const { connector } = createMercadoLibreTestKit();

    const event = connector.verifyWebhook(
      webhook(loadFixture(FIXTURES, 'notification-order.json')),
    );

    expect(event).toMatchObject({
      kind: ChannelWebhookKind.OrderChanged,
      topic: 'orders_v2',
      externalAccountId: '468424240',
      deliveryId: 'f9f08571-1f65-4c46-9e0a-c0f43faas1557e',
      resourceId: '2195160686',
    });
  });

  it('reads items and moderations notifications as ListingChanged with the item id', () => {
    const { connector } = createMercadoLibreTestKit();
    const item = { ...fixtureJson('notification-item.json'), application_id: '5503910054141466' };
    const moderation = {
      _id: 'mod-1',
      resource: '/moderations/items/MEC123456789',
      user_id: '123456789',
      topic: 'moderations',
      application_id: '5503910054141466',
    };

    expect(connector.verifyWebhook(webhook(item))).toMatchObject({
      kind: ChannelWebhookKind.ListingChanged,
      topic: 'items',
      externalAccountId: '123456789',
      resourceId: expect.stringMatching(/^[A-Z]{2,4}\d+$/) as string,
    });
    expect(connector.verifyWebhook(webhook(moderation))).toMatchObject({
      kind: ChannelWebhookKind.ListingChanged,
      topic: 'moderations',
      externalAccountId: '123456789',
      resourceId: 'MEC123456789',
    });
  });

  it('acknowledges unhandled topics of the app without acting on them', () => {
    const { connector } = createMercadoLibreTestKit();
    const question = {
      _id: 'q-1',
      resource: '/questions/998877',
      user_id: '123456789',
      topic: 'questions',
      application_id: '5503910054141466',
    };

    expect(connector.verifyWebhook(webhook(question))).toMatchObject({
      kind: ChannelWebhookKind.Unhandled,
      topic: 'questions',
      externalAccountId: '123456789',
    });
  });

  it('refuses notifications for another app, bodies that are not one, and an unconfigured app', () => {
    const { connector } = createMercadoLibreTestKit();
    const unconfigured = createMercadoLibreTestKit(new MercadoLibreApp(null)).connector;
    const order = loadFixture(FIXTURES, 'notification-order.json');

    expect(
      connector.verifyWebhook(webhook(loadFixture(FIXTURES, 'notification-item.json'))),
    ).toBeNull();
    expect(connector.verifyWebhook(webhook('not json'))).toBeNull();
    expect(connector.verifyWebhook(webhook({ topic: 'orders_v2' }))).toBeNull();
    expect(unconfigured.verifyWebhook(webhook(order))).toBeNull();
  });
});
