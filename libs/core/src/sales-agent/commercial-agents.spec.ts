import { ConflictException } from '@nestjs/common';
import {
  AiConfigStatus,
  ChatwootConnectionStatus,
  OutOfStockPolicy,
  SalesAgentMode,
} from '@crossmart/database';
import { AiContentBlockType } from '../ai/enums/ai-content-block-type.enum.js';
import { AiProviderName } from '../ai/enums/ai-provider-name.enum.js';
import { AiStopReason } from '../ai/enums/ai-stop-reason.enum.js';
import { AiConnectionsService } from '../ai/services/ai-connections.service.js';
import { ChannelPriceResolver } from '../listings/services/channel-price-resolver.js';
import { SalesAgentService } from './sales-agent.service.js';
import { SalesAgentToolsService } from './sales-agent-tools.service.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const CONN_ID = '22222222-2222-4222-8222-222222222222';

describe('SalesAgentToolsService (backend security boundary)', () => {
  it('returns real active prices and stock while never exposing cost, margins, or private metadata', async () => {
    const prisma = {
      workspace: { findUnique: vi.fn().mockResolvedValue({ currencyCode: 'USD' }) },
      product: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'prod-1',
            title: 'Producto Comercial Real',
            descriptionHtml: '<p>Alta resistencia</p>',
            vendor: 'Marca Demo',
            tags: ['ferreteria'],
            media: [{ url: 'https://cdn.example.com/p1.webp' }],
            listings: [
              {
                externalUrl: 'https://articulo.mercadolibre.com.ec/MEC123',
                connection: { id: 'store-1', displayName: 'Mercado Libre EC' },
              },
            ],
            variants: [
              {
                id: 'var-1',
                sku: '1389',
                optionValues: [],
                price: { toString: () => '9.00' },
                compareAtPrice: null,
                outOfStockPolicy: OutOfStockPolicy.STOP_SELLING,
                inventoryItem: { tracked: true, available: 10 },
              },
            ],
          },
        ]),
      },
    };

    const tools = new SalesAgentToolsService(prisma as never, new ChannelPriceResolver());
    const result = await tools.execute(
      WORKSPACE_ID,
      'search_catalog_products',
      { query: '1389' },
      {},
    );
    const serialized = JSON.stringify(result.output);

    expect(result.output.count).toBe(1);
    expect(serialized).toContain('"price":"9.00"');
    expect(serialized).toContain('"availableQuantity":10');
    expect(serialized).toContain('"inStock":true');
    expect(serialized).not.toContain('unitCost');
    expect(serialized).not.toContain('margin');
    expect(serialized).not.toContain('sourceMetadata');

    // Verify Prisma select never requested cost or sourceMetadata
    const selectArg = prisma.product.findMany.mock.calls[0]?.[0]?.select;
    expect(selectArg).not.toHaveProperty('sourceMetadata');
    expect(selectArg.variants.select).not.toHaveProperty('cost');

    const denied = await tools.execute(WORKSPACE_ID, 'delete_product', { id: 'prod-1' }, {});
    expect(denied.output).toEqual({
      error: "Tool 'delete_product' is not permitted for the Sales Agent.",
    });
  });
});

describe('SalesAgentService Chatwoot webhook pipeline', () => {
  function makeService(
    overrides: {
      salesMode?: SalesAgentMode;
      authorizedInboxIds?: number[];
      liveAssigneeId?: number | null;
      duplicate?: boolean;
      handoff?: boolean;
    } = {},
  ) {
    const sendMessage = vi.fn().mockResolvedValue({ id: 900 });
    const toggleConversationStatus = vi.fn().mockResolvedValue(undefined);
    const getConversation = vi.fn().mockResolvedValue({
      id: 42,
      status: 'pending',
      inboxId: 7,
      assigneeId: overrides.liveAssigneeId ?? null,
    });
    const prisma = {
      chatwootWebhookEvent: {
        create: overrides.duplicate
          ? vi.fn().mockRejectedValue(new Error('Unique constraint'))
          : vi.fn().mockResolvedValue({ id: 'evt-1' }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      salesConversation: {
        findFirst: vi.fn().mockResolvedValue({ id: 'sconv-1' }),
        create: vi.fn().mockResolvedValue({ id: 'sconv-1' }),
      },
      salesMessage: {
        create: vi.fn().mockResolvedValue({ id: 'smsg-1' }),
        findMany: vi.fn().mockResolvedValue([{ role: 'buyer', text: 'Precio por favor?' }]),
      },
    };
    const ai = {
      converse: vi.fn().mockImplementation(async () => ({
        content: overrides.handoff
          ? [
              {
                type: AiContentBlockType.ToolUse,
                id: 't1',
                name: 'handoff_to_human',
                input: { reason: 'Buyer requested invoice discount' },
              },
            ]
          : [{ type: AiContentBlockType.Text, text: 'Hola, el precio vigente es $9.00.' }],
        model: 'test-model',
        stopReason: AiStopReason.Completed,
        usage: { inputTokens: 10, outputTokens: 10 },
      })),
    };
    if (overrides.handoff) {
      ai.converse
        .mockResolvedValueOnce({
          content: [
            {
              type: AiContentBlockType.ToolUse,
              id: 't1',
              name: 'handoff_to_human',
              input: { reason: 'Buyer requested invoice discount' },
            },
          ],
          model: 'test-model',
          stopReason: AiStopReason.Completed,
          usage: { inputTokens: 10, outputTokens: 10 },
        })
        .mockResolvedValueOnce({
          content: [{ type: AiContentBlockType.Text, text: 'Te transfiero con un asesor humano.' }],
          model: 'test-model',
          stopReason: AiStopReason.Completed,
          usage: { inputTokens: 10, outputTokens: 10 },
        });
    }
    const configs = {
      get: vi.fn().mockResolvedValue({
        agentKey: 'sales',
        aiConnectionId: 'ai-1',
        model: 'test-model',
        chatwootConnectionId: CONN_ID,
        authorizedInboxIds: overrides.authorizedInboxIds ?? [7],
        commercialPolicy: {},
        salesMode: overrides.salesMode ?? SalesAgentMode.DISABLED,
        updatedAt: null,
      }),
    };
    const tools = {
      definitions: vi.fn().mockReturnValue([]),
      execute: vi.fn().mockResolvedValue({
        output: { handedOff: true },
        handoff: { reason: 'Buyer requested invoice discount' },
      }),
    };
    const chatwootConns = {
      openOperationalConnection: vi.fn().mockResolvedValue({
        connection: {
          id: CONN_ID,
          workspaceId: WORKSPACE_ID,
          baseUrl: 'https://chat.example.com',
          accountId: 1,
          status: ChatwootConnectionStatus.CONNECTED,
        },
        credentials: { apiAccessToken: 'admin-tok', agentBotToken: 'bot-tok', webhookSecret: null },
      }),
    };
    const service = new SalesAgentService(
      prisma as never,
      ai as never,
      configs as never,
      tools as never,
      chatwootConns as never,
      { sendMessage, toggleConversationStatus, getConversation } as never,
    );
    return { service, sendMessage, toggleConversationStatus };
  }

  const incomingPayload = {
    event: 'message_created',
    id: 501,
    message_type: 'incoming',
    private: false,
    content: 'Hola, tienen stock?',
    sender: { id: 10, type: 'contact' },
    inbox: { id: 7 },
    conversation: { id: 42, inbox_id: 7, meta: { assignee: null } },
  };

  it('prevents loops, deduplicates events, and respects DISABLED and human-assigned conversations', async () => {
    const { service, sendMessage } = makeService({ salesMode: SalesAgentMode.AUTOMATIC });

    // Outgoing bot message ignored
    const loop = await service.handleChatwootWebhook(CONN_ID, {
      ...incomingPayload,
      message_type: 'outgoing',
    });
    expect(loop.outcome).toBe('ignored');
    expect(sendMessage).not.toHaveBeenCalled();

    // Duplicate event ignored
    const dupKit = makeService({ salesMode: SalesAgentMode.AUTOMATIC, duplicate: true });
    const dup = await dupKit.service.handleChatwootWebhook(CONN_ID, incomingPayload);
    expect(dup.outcome).toBe('duplicate');
    expect(dupKit.sendMessage).not.toHaveBeenCalled();

    // Disabled mode ignored
    const disKit = makeService({ salesMode: SalesAgentMode.DISABLED });
    const dis = await disKit.service.handleChatwootWebhook(CONN_ID, incomingPayload);
    expect(dis).toMatchObject({ outcome: 'ignored', detail: 'mode_disabled' });
    expect(disKit.sendMessage).not.toHaveBeenCalled();

    // Live human assignment blocks sending even in AUTOMATIC mode
    const humanKit = makeService({ salesMode: SalesAgentMode.AUTOMATIC, liveAssigneeId: 99 });
    const human = await humanKit.service.handleChatwootWebhook(CONN_ID, incomingPayload);
    expect(human).toMatchObject({ outcome: 'ignored', detail: 'assigned_to_human_live' });
    expect(humanKit.sendMessage).not.toHaveBeenCalled();
  });

  it('sends private notes in SUPERVISED mode and public reply + handoff toggle in AUTOMATIC mode', async () => {
    const sup = makeService({ salesMode: SalesAgentMode.SUPERVISED });
    const supRes = await sup.service.handleChatwootWebhook(CONN_ID, incomingPayload);
    expect(supRes.outcome).toBe('supervised_draft');
    expect(sup.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ isPrivate: true }));

    const autoHandoff = makeService({ salesMode: SalesAgentMode.AUTOMATIC, handoff: true });
    const handoffRes = await autoHandoff.service.handleChatwootWebhook(CONN_ID, incomingPayload);
    expect(handoffRes.outcome).toBe('handoff');
    expect(autoHandoff.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ isPrivate: false }),
    );
    expect(autoHandoff.toggleConversationStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'open' }),
    );
  });
});

describe('AiConnectionsService dependency protection', () => {
  it('blocks deleting a connection that is assigned to an internal agent', async () => {
    const prisma = {
      aiConnection: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'ai-1',
          workspaceId: WORKSPACE_ID,
          name: 'OpenAI Primary',
          provider: AiProviderName.OpenAi,
          status: AiConfigStatus.CONNECTED,
          isDefault: false,
        }),
        delete: vi.fn(),
      },
      workspaceAgentConfig: {
        findMany: vi.fn().mockResolvedValue([{ agentKey: 'sales' }]),
      },
    };
    const svc = new AiConnectionsService(
      prisma as never,
      {} as never,
      {} as never,
      { isConfigured: () => false } as never,
      { record: vi.fn() } as never,
    );
    await expect(
      svc.deleteConnection(WORKSPACE_ID, 'ai-1', { userId: 'u1' } as never),
    ).rejects.toThrow(ConflictException);
    expect(prisma.aiConnection.delete).not.toHaveBeenCalled();
  });
});
