import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AiContentBlockType } from '../../enums/ai-content-block-type.enum.js';
import { AiConversationRole } from '../../enums/ai-conversation-role.enum.js';
import { AiProviderName } from '../../enums/ai-provider-name.enum.js';
import { AiStopReason } from '../../enums/ai-stop-reason.enum.js';
import {
  AiKeyRejectedError,
  AiOutputRejectedError,
  AiProviderUnavailableError,
} from '../../errors/ai.errors.js';
import { OpenAiCompatibleAiProvider } from './openai-compatible-ai.provider.js';
import { normalizeOpenAiBaseUrl } from './openai-compatible-url.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sseResponse(events: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(event));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('normalizeOpenAiBaseUrl', () => {
  it('accepts public HTTPS URLs and strips trailing slashes or /chat/completions', () => {
    expect(normalizeOpenAiBaseUrl('https://api.example.com/v1/chat/completions/')).toEqual({
      baseUrl: 'https://api.example.com/v1',
      isPrivate: false,
    });
  });

  it('allows HTTP only for explicit local or private endpoints and blocks metadata/credentials', () => {
    expect(normalizeOpenAiBaseUrl('http://127.0.0.1:11434/v1')).toEqual({
      baseUrl: 'http://127.0.0.1:11434/v1',
      isPrivate: true,
    });
    expect(() => normalizeOpenAiBaseUrl('http://api.example.com/v1')).toThrow(/HTTPS/);
    expect(() => normalizeOpenAiBaseUrl('https://user:pass@api.example.com/v1')).toThrow(
      /credenciales/,
    );
    expect(() => normalizeOpenAiBaseUrl('http://169.254.169.254/latest')).toThrow(/metadatos/);
  });
});

describe('OpenAiCompatibleAiProvider', () => {
  const schema = z.object({ title: z.string(), tags: z.array(z.string()) });

  it('completes structured outputs using json_schema and falls back cleanly when unsupported', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ error: { message: 'response_format json_schema is not supported' } }, 400),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          model: 'demo-chat-model',
          choices: [
            {
              message: { content: '```json\n{"title":"Cable USB-C","tags":["usb-c"]}\n```' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 120, completion_tokens: 45 },
        }),
      );

    const provider = new OpenAiCompatibleAiProvider({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test-key',
      model: 'demo-chat-model',
      fetchImpl: fetchMock,
    });

    const completion = await provider.complete({
      system: 'Write JSON.',
      prompt: 'Product data',
      schema,
      maxOutputTokens: 500,
    });

    expect(provider.name).toBe(AiProviderName.OpenAiCompatible);
    expect(completion).toEqual({
      text: '{"title":"Cable USB-C","tags":["usb-c"]}',
      model: 'demo-chat-model',
      stopReason: AiStopReason.Completed,
      usage: { inputTokens: 120, outputTokens: 45 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondInit = fetchMock.mock.calls[1]?.[1];
    expect(
      JSON.parse(typeof secondInit?.body === 'string' ? secondInit.body : '{}').response_format,
    ).toEqual({
      type: 'json_object',
    });
    expect(secondInit?.redirect).toBe('manual');
  });

  it('streams SSE deltas, accumulates streamed tool calls, and reports real token usage', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        sseResponse([
          'data: {"model":"demo-chat","choices":[{"delta":{"content":"Buscando "}}]}\n\n',
          'data: {"model":"demo-chat","choices":[{"delta":{"content":"producto...","tool_calls":[{"index":0,"id":"call_1","function":{"name":"search_","arguments":"{\\"query\\":"}}]}}]}\n\n',
          'data: {"model":"demo-chat","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"products","arguments":"\\"hdmi\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
          'data: {"model":"demo-chat","choices":[],"usage":{"prompt_tokens":210,"completion_tokens":38}}\n\n',
          'data: [DONE]\n\n',
        ]),
      );

    const provider = new OpenAiCompatibleAiProvider({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test-key',
      model: 'demo-chat',
      fetchImpl: fetchMock,
    });

    const deltas: string[] = [];
    const reply = await provider.converse(
      {
        system: 'You are an operator assistant.',
        messages: [
          {
            role: AiConversationRole.User,
            content: [{ type: AiContentBlockType.Text, text: 'Busca adaptadores HDMI' }],
          },
        ],
        tools: [
          {
            name: 'search_products',
            description: 'Search catalog',
            inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
          },
        ],
        maxOutputTokens: 1000,
      },
      { onTextDelta: (delta) => deltas.push(delta) },
    );

    expect(deltas.join('')).toBe('Buscando producto...');
    expect(reply).toEqual({
      model: 'demo-chat',
      stopReason: AiStopReason.ToolUse,
      usage: { inputTokens: 210, outputTokens: 38 },
      content: [
        { type: AiContentBlockType.Text, text: 'Buscando producto...' },
        {
          type: AiContentBlockType.ToolUse,
          id: 'call_1',
          name: 'search_products',
          input: { query: 'hdmi' },
        },
      ],
    });
  });

  it('maps auth, rate limit, redirect, and unsupported-tools failures accurately without fabricating usage', async () => {
    const unauthorized = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'Invalid API key' } }, 401));
    const providerAuth = new OpenAiCompatibleAiProvider({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'bad-key',
      model: 'demo-chat',
      fetchImpl: unauthorized,
    });
    await expect(
      providerAuth.complete({ system: 'sys', prompt: 'p', schema, maxOutputTokens: 100 }),
    ).rejects.toThrow(AiKeyRejectedError);

    const rateLimited = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({}, 429));
    const providerLimit = new OpenAiCompatibleAiProvider({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-key',
      model: 'demo-chat',
      fetchImpl: rateLimited,
    });
    await expect(
      providerLimit.complete({ system: 'sys', prompt: 'p', schema, maxOutputTokens: 100 }),
    ).rejects.toThrow(AiProviderUnavailableError);

    const redirected = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'https://evil.test' } }),
      );
    const providerRedirect = new OpenAiCompatibleAiProvider({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-key',
      model: 'demo-chat',
      fetchImpl: redirected,
    });
    await expect(
      providerRedirect.complete({ system: 'sys', prompt: 'p', schema, maxOutputTokens: 100 }),
    ).rejects.toThrow(AiProviderUnavailableError);

    const noTools = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ error: { message: 'This model does not support tools' } }, 400),
      );
    const providerNoTools = new OpenAiCompatibleAiProvider({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-key',
      model: 'demo-chat',
      fetchImpl: noTools,
    });
    await expect(
      providerNoTools.converse(
        {
          system: 'sys',
          messages: [
            {
              role: AiConversationRole.User,
              content: [{ type: AiContentBlockType.Text, text: 'hi' }],
            },
          ],
          tools: [{ name: 't', description: 'd', inputSchema: { type: 'object' } }],
          maxOutputTokens: 100,
        },
        { onTextDelta: () => undefined },
      ),
    ).rejects.toThrow(AiOutputRejectedError);
  });

  it('lists models when /models is available and degrades gracefully on 404', async () => {
    const okFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        data: [
          { id: 'model-b', owned_by: 'org-b' },
          { id: 'model-a', owned_by: 'org-a' },
        ],
      }),
    );
    const providerOk = new OpenAiCompatibleAiProvider({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-key',
      model: 'model-a',
      fetchImpl: okFetch,
    });
    expect(await providerOk.listModels()).toEqual({
      supported: true,
      models: [
        { id: 'model-a', ownedBy: 'org-a' },
        { id: 'model-b', ownedBy: 'org-b' },
      ],
    });

    const missingFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 404 }));
    const providerMissing = new OpenAiCompatibleAiProvider({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-key',
      model: 'model-a',
      fetchImpl: missingFetch,
    });
    expect(await providerMissing.listModels()).toEqual({ supported: false, models: [] });
  });
});
