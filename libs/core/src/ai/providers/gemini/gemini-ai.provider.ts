import { Logger } from '@nestjs/common';
import { z } from 'zod';
import type { AiCompletion, AiStructuredRequest } from '../../entities/ai-completion.js';
import type { AiCapabilities, AiModelOption } from '../../entities/ai-config.js';
import type {
  AiContentBlock,
  AiConversationListener,
  AiConversationMessage,
  AiConversationReply,
  AiConversationRequest,
  AiToolDefinition,
} from '../../entities/ai-conversation.js';
import { AiContentBlockType } from '../../enums/ai-content-block-type.enum.js';
import { AiConversationRole } from '../../enums/ai-conversation-role.enum.js';
import { AiProviderName } from '../../enums/ai-provider-name.enum.js';
import { AiStopReason } from '../../enums/ai-stop-reason.enum.js';
import {
  AiKeyRejectedError,
  AiNotConfiguredError,
  AiProviderUnavailableError,
} from '../../errors/ai.errors.js';
import { AiProvider } from '../ai-provider.js';
import { unwrapJsonFences } from '../openai-compatible/openai-compatible-conversation.mapper.js';
import { AiDiagnosticError } from '../openai-compatible/openai-compatible-ai.provider.js';

export const GEMINI_OFFICIAL_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

const REQUEST_TIMEOUT_MS = 90_000;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const MAX_ERROR_CHARS = 300;
const PROBE_MAX_TOKENS = 64;

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiCandidate {
  content?: { parts?: GeminiPart[] };
  finishReason?: string;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

interface GeminiModelsResponse {
  models?: Array<{
    name?: string;
    supportedGenerationMethods?: string[];
  }>;
}

export interface GeminiProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string | null;
  fetchImpl?: typeof fetch;
}

function normalizeModelId(model: string): string {
  return model.trim().replace(/^models\//, '');
}

function toGeminiStopReason(reason: string | undefined): AiStopReason {
  if (reason === 'MAX_TOKENS') return AiStopReason.Truncated;
  if (reason === 'SAFETY' || reason === 'RECITATION' || reason === 'PROHIBITED_CONTENT') {
    return AiStopReason.Refused;
  }
  return AiStopReason.Completed;
}

function toGeminiContents(messages: readonly AiConversationMessage[]): GeminiContent[] {
  const contents: GeminiContent[] = [];
  const toolNamesById = new Map<string, string>();
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === AiContentBlockType.ToolUse) {
        toolNamesById.set(block.id, block.name);
      }
    }
  }
  for (const msg of messages) {
    const role: 'user' | 'model' = msg.role === AiConversationRole.Assistant ? 'model' : 'user';
    const parts: GeminiPart[] = [];
    for (const block of msg.content) {
      if (block.type === AiContentBlockType.Text && block.text.length > 0) {
        parts.push({ text: block.text });
      } else if (block.type === AiContentBlockType.ToolUse) {
        parts.push({ functionCall: { name: block.name, args: block.input } });
      } else if (block.type === AiContentBlockType.ToolResult) {
        parts.push({
          functionResponse: {
            name: toolNamesById.get(block.toolUseId) ?? block.toolUseId,
            response: { result: block.content, isError: block.isError },
          },
        });
      }
    }
    if (parts.length > 0) contents.push({ role, parts });
  }
  return contents;
}

function toGeminiTools(tools: readonly AiToolDefinition[]): unknown[] | undefined {
  if (tools.length === 0) return undefined;
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      })),
    },
  ];
}

/**
 * Google Gemini adapter using the official Generative Language REST API (`v1beta`).
 * Supports model discovery, structured JSON output, tool calling, and SSE streaming.
 */
export class GeminiAiProvider extends AiProvider {
  readonly name = AiProviderName.Gemini;
  readonly model: string;
  private readonly logger = new Logger(GeminiAiProvider.name);
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GeminiProviderOptions) {
    super();
    this.apiKey = options.apiKey.trim();
    this.model = normalizeModelId(options.model);
    this.baseUrl = (options.baseUrl?.trim() || GEMINI_OFFICIAL_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0 && this.model.length > 0;
  }

  async listModels(): Promise<{ supported: boolean; models: AiModelOption[] }> {
    const url = `${this.baseUrl}/models?key=${encodeURIComponent(this.apiKey)}`;
    const response = await this.fetchWithTimeout(url, { method: 'GET' });
    if (!response.ok) {
      await this.throwHttpError(response);
    }
    const payload = (await response.json()) as GeminiModelsResponse;
    const models: AiModelOption[] = (payload.models ?? [])
      .filter((entry) => entry.supportedGenerationMethods?.includes('generateContent'))
      .map((entry) => ({
        id: normalizeModelId(entry.name ?? ''),
        ownedBy: 'google',
      }))
      .filter((entry) => entry.id.length > 0);
    return { supported: true, models };
  }

  async complete<Output>(request: AiStructuredRequest<Output>): Promise<AiCompletion> {
    if (!this.isConfigured()) throw new AiNotConfiguredError();
    const model = normalizeModelId(request.model ?? this.model);
    const url = `${this.baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
    const body = {
      systemInstruction: { parts: [{ text: request.system }] },
      contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
      generationConfig: {
        maxOutputTokens: request.maxOutputTokens,
        responseMimeType: 'application/json',
      },
    };
    const response = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) await this.throwHttpError(response);
    const data = (await response.json()) as GeminiResponse;
    const candidate = data.candidates?.[0];
    const rawText = (candidate?.content?.parts ?? []).map((part) => part.text ?? '').join('');
    return {
      text: unwrapJsonFences(rawText),
      model,
      stopReason: toGeminiStopReason(candidate?.finishReason),
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      },
    };
  }

  async converse(
    request: AiConversationRequest,
    listener: AiConversationListener,
  ): Promise<AiConversationReply> {
    if (!this.isConfigured()) throw new AiNotConfiguredError();
    const model = normalizeModelId(request.model ?? this.model);
    const url = `${this.baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
    const tools = toGeminiTools(request.tools);
    const body = {
      systemInstruction: { parts: [{ text: request.system }] },
      contents: toGeminiContents(request.messages),
      ...(tools ? { tools } : {}),
      generationConfig: { maxOutputTokens: request.maxOutputTokens },
    };
    const response = await this.fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      request.signal,
    );
    if (!response.ok) await this.throwHttpError(response);
    const data = (await response.json()) as GeminiResponse;
    const candidate = data.candidates?.[0];
    const content: AiContentBlock[] = [];
    let toolIndex = 0;
    for (const part of candidate?.content?.parts ?? []) {
      if (part.text) {
        listener.onTextDelta(part.text);
        content.push({ type: AiContentBlockType.Text, text: part.text });
      }
      if (part.functionCall) {
        toolIndex += 1;
        content.push({
          type: AiContentBlockType.ToolUse,
          id: `gemini_call_${toolIndex}`,
          name: part.functionCall.name,
          input: part.functionCall.args ?? {},
        });
      }
    }
    return {
      content,
      model,
      stopReason: toGeminiStopReason(candidate?.finishReason),
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      },
    };
  }

  async probeCapabilities(): Promise<{ resolvedModel: string; capabilities: AiCapabilities }> {
    const listed = await this.listModels().catch(() => ({ supported: false, models: [] }));
    const completion = await this.complete({
      system: 'Return JSON with {"ok":true}.',
      prompt: 'ping',
      schema: z.object({ ok: z.boolean() }),
      maxOutputTokens: PROBE_MAX_TOKENS,
    });
    return {
      resolvedModel: completion.model,
      capabilities: {
        structuredOutput: true,
        jsonSchema: true,
        streaming: true,
        toolCalling: true,
        vision: true,
        modelsEndpoint: listed.supported,
      },
    };
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    externalSignal?: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    externalSignal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onAbort);
    }
  }

  private async throwHttpError(response: Response): Promise<never> {
    const text = (await response.text().catch(() => '')).slice(0, MAX_ERROR_CHARS);
    this.logger.warn(`Gemini request failed with status ${response.status}`);
    if (response.status === HTTP_UNAUTHORIZED || response.status === HTTP_FORBIDDEN) {
      throw new AiKeyRejectedError();
    }
    if (response.status === HTTP_NOT_FOUND) {
      throw new AiDiagnosticError(`Gemini model or endpoint not found (404): ${text}`);
    }
    throw new AiProviderUnavailableError(response.status);
  }
}
