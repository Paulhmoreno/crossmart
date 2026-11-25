import { Logger } from '@nestjs/common';
import { z } from 'zod';
import type { AiCompletion, AiStructuredRequest } from '../../entities/ai-completion.js';
import type { AiCapabilities, AiModelOption } from '../../entities/ai-config.js';
import type {
  AiContentBlock,
  AiConversationListener,
  AiConversationReply,
  AiConversationRequest,
} from '../../entities/ai-conversation.js';
import { AiContentBlockType } from '../../enums/ai-content-block-type.enum.js';
import { AiProviderName } from '../../enums/ai-provider-name.enum.js';
import {
  AiKeyRejectedError,
  AiOutputRejectedError,
  AiProviderUnavailableError,
} from '../../errors/ai.errors.js';
import { AiProvider } from '../ai-provider.js';
import {
  type OpenAiChatMessage,
  parseToolArguments,
  toOpenAiMessages,
  toOpenAiStopReason,
  toOpenAiTools,
  unwrapJsonFences,
} from './openai-compatible-conversation.mapper.js';
import { parseOpenAiSseStream } from './openai-compatible-sse.parser.js';
import { normalizeOpenAiBaseUrl } from './openai-compatible-url.js';

const REQUEST_TIMEOUT_MS = 90_000;
const PROBE_TIMEOUT_MS = 25_000;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_METHOD_NOT_ALLOWED = 405;
const HTTP_UNPROCESSABLE = 422;
const HTTP_NOT_IMPLEMENTED = 501;
const HTTP_REDIRECT_MIN = 300;
const HTTP_REDIRECT_MAX = 399;
const MAX_ERROR_BODY_CHARS = 300;

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  apiKey: string | null;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface OpenAiCompletionResponse {
  model?: string;
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }> | null;
      refusal?: string | null;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  } | null;
}

interface OpenAiModelsResponse {
  data?: Array<{ id?: string; owned_by?: string }>;
}

interface HttpFailure {
  status: number;
  message: string;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function extractMessageText(
  content: string | Array<{ type?: string; text?: string }> | null | undefined,
): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (typeof part.text === 'string' ? part.text : '')).join('');
}

function sanitizeJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === '$schema') continue;
    if (Array.isArray(value)) {
      clone[key] = value.map((item) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? sanitizeJsonSchema(item as Record<string, unknown>)
          : item,
      );
    } else if (value && typeof value === 'object') {
      clone[key] = sanitizeJsonSchema(value as Record<string, unknown>);
    } else {
      clone[key] = value;
    }
  }
  if (clone.type === 'object' && clone.additionalProperties === undefined) {
    clone.additionalProperties = false;
  }
  return clone;
}

function toJsonSchema(zodSchema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(zodSchema) as Record<string, unknown>;
  return sanitizeJsonSchema(raw);
}

function isFormatUnsupported(failure: HttpFailure): boolean {
  if (failure.status !== HTTP_BAD_REQUEST && failure.status !== HTTP_UNPROCESSABLE) return false;
  return /response_format|json_schema|json_object|structured|strict|grammar|not supported|unsupported/i.test(
    failure.message,
  );
}

function isStreamOptionsUnsupported(failure: HttpFailure): boolean {
  if (failure.status !== HTTP_BAD_REQUEST && failure.status !== HTTP_UNPROCESSABLE) return false;
  return /stream_options|include_usage|unknown field|extra_forbidden|unrecognized/i.test(
    failure.message,
  );
}

function isToolsUnsupported(failure: HttpFailure): boolean {
  if (failure.status !== HTTP_BAD_REQUEST && failure.status !== HTTP_UNPROCESSABLE) return false;
  return /tool|function|does not support tools|not supported/i.test(failure.message);
}

function extractErrorMessage(bodyText: string): string {
  const trimmed = bodyText.trim();
  if (!trimmed) return '';
  try {
    const parsed = JSON.parse(trimmed) as {
      error?: { message?: string } | string;
      message?: string;
    };
    if (typeof parsed.error === 'string') return parsed.error.slice(0, MAX_ERROR_BODY_CHARS);
    if (typeof parsed.error?.message === 'string') {
      return parsed.error.message.slice(0, MAX_ERROR_BODY_CHARS);
    }
    if (typeof parsed.message === 'string') return parsed.message.slice(0, MAX_ERROR_BODY_CHARS);
  } catch {
    // Plain text error body.
  }
  return trimmed.slice(0, MAX_ERROR_BODY_CHARS);
}

/**
 * Generic OpenAI Chat Completions compatible `AiProvider`.
 * Supports OpenAI, OpenRouter, DeepSeek, Groq, private compatible servers, and future Ollama
 * instances using one native adapter without vendor lock-in.
 */
export class OpenAiCompatibleAiProvider extends AiProvider {
  readonly name = AiProviderName.OpenAiCompatible;
  readonly model: string;
  readonly baseUrl: string;
  readonly isPrivateEndpoint: boolean;
  private readonly apiKey: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly logger = new Logger(OpenAiCompatibleAiProvider.name);

  constructor(options: OpenAiCompatibleOptions) {
    super();
    const normalized = normalizeOpenAiBaseUrl(options.baseUrl);
    this.baseUrl = normalized.baseUrl;
    this.isPrivateEndpoint = normalized.isPrivate;
    this.apiKey = options.apiKey?.trim() || null;
    this.model = options.model.trim();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  isConfigured(): boolean {
    if (!this.baseUrl || !this.model) return false;
    return this.isPrivateEndpoint || Boolean(this.apiKey);
  }

  async complete<Output>(request: AiStructuredRequest<Output>): Promise<AiCompletion> {
    const model = request.model?.trim() || this.model;
    const jsonSchema = toJsonSchema(request.schema);
    const messages: OpenAiChatMessage[] = [
      { role: 'system', content: request.system },
      { role: 'user', content: request.prompt },
    ];

    const strictPayload = {
      model,
      messages,
      max_tokens: request.maxOutputTokens,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'crossmart_response',
          strict: true,
          schema: jsonSchema,
        },
      },
    };

    try {
      const data = await this.postJson<OpenAiCompletionResponse>(
        '/chat/completions',
        strictPayload,
      );
      return this.toCompletion(data, model);
    } catch (error) {
      if (!this.isRecoverableFormatFailure(error)) {
        throw this.toProviderError(error);
      }
    }

    const schemaReminder = `${request.system}\n\nRespond ONLY with a single valid JSON object matching this JSON Schema (no markdown fences, no commentary):\n${JSON.stringify(jsonSchema)}`;
    const fallbackMessages: OpenAiChatMessage[] = [
      { role: 'system', content: schemaReminder },
      { role: 'user', content: request.prompt },
    ];

    try {
      const data = await this.postJson<OpenAiCompletionResponse>('/chat/completions', {
        model,
        messages: fallbackMessages,
        max_tokens: request.maxOutputTokens,
        response_format: { type: 'json_object' },
      });
      return this.toCompletion(data, model);
    } catch (error) {
      if (!this.isRecoverableFormatFailure(error)) {
        throw this.toProviderError(error);
      }
    }

    try {
      const data = await this.postJson<OpenAiCompletionResponse>('/chat/completions', {
        model,
        messages: fallbackMessages,
        max_tokens: request.maxOutputTokens,
      });
      return this.toCompletion(data, model);
    } catch (error) {
      throw this.toProviderError(error);
    }
  }

  async converse(
    request: AiConversationRequest,
    listener: AiConversationListener,
  ): Promise<AiConversationReply> {
    const model = request.model?.trim() || this.model;
    const messages = toOpenAiMessages(request.system, request.messages);
    const tools = request.tools.length > 0 ? toOpenAiTools(request.tools) : undefined;
    const basePayload: Record<string, unknown> = {
      model,
      messages,
      max_tokens: request.maxOutputTokens,
      ...(tools ? { tools } : {}),
    };

    try {
      return await this.streamChat(
        { ...basePayload, stream: true, stream_options: { include_usage: true } },
        model,
        listener,
        request.signal,
      );
    } catch (error) {
      if (this.isHttpFailure(error) && isStreamOptionsUnsupported(error)) {
        try {
          return await this.streamChat(
            { ...basePayload, stream: true },
            model,
            listener,
            request.signal,
          );
        } catch (retryError) {
          throw this.toConversationError(retryError);
        }
      }
      throw this.toConversationError(error);
    }
  }

  /** Lists available models from `GET <baseUrl>/models` when supported by the server. */
  async listModels(): Promise<{ supported: boolean; models: AiModelOption[] }> {
    try {
      const response = await this.send('/models', { method: 'GET' }, undefined, PROBE_TIMEOUT_MS);
      if (
        response.status === HTTP_NOT_FOUND ||
        response.status === HTTP_METHOD_NOT_ALLOWED ||
        response.status === HTTP_NOT_IMPLEMENTED
      ) {
        return { supported: false, models: [] };
      }
      if (!response.ok) {
        throw await this.readFailure(response);
      }
      const parsed = (await response.json()) as OpenAiModelsResponse;
      const models = (parsed.data ?? [])
        .filter((entry): entry is { id: string; owned_by?: string } => Boolean(entry.id?.trim()))
        .map((entry) => ({ id: entry.id.trim(), ownedBy: entry.owned_by?.trim() || null }))
        .sort((left, right) => left.id.localeCompare(right.id));
      return { supported: true, models };
    } catch (error) {
      if (this.isHttpFailure(error)) {
        if (error.status === HTTP_UNAUTHORIZED || error.status === HTTP_FORBIDDEN) {
          throw new AiKeyRejectedError();
        }
      }
      throw this.toProviderError(error);
    }
  }

  /** Verifies connectivity and probes real model capabilities without inventing them. */
  async probeCapabilities(): Promise<{ resolvedModel: string; capabilities: AiCapabilities }> {
    // 1. Mandatory lightweight completion to confirm auth + model availability.
    const basicData = await this.postJson<OpenAiCompletionResponse>(
      '/chat/completions',
      {
        model: this.model,
        messages: [{ role: 'user', content: 'Respond with OK.' }],
        max_tokens: 16,
      },
      undefined,
      PROBE_TIMEOUT_MS,
    ).catch((error) => {
      throw this.toProviderError(error);
    });
    const resolvedModel = basicData.model?.trim() || this.model;

    // 2. Check /models endpoint support (non-fatal).
    let modelsEndpoint = false;
    try {
      const list = await this.listModels();
      modelsEndpoint = list.supported;
    } catch {
      modelsEndpoint = false;
    }

    // 3. Check strict json_schema and fallback structured output support.
    let jsonSchema = false;
    let structuredOutput = false;
    const probeSchema = z.object({ ok: z.boolean() });
    try {
      const schemaRes = await this.postJson<OpenAiCompletionResponse>(
        '/chat/completions',
        {
          model: this.model,
          messages: [
            { role: 'system', content: 'Return JSON with ok=true.' },
            { role: 'user', content: 'ping' },
          ],
          max_tokens: 32,
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'probe',
              strict: true,
              schema: toJsonSchema(probeSchema),
            },
          },
        },
        undefined,
        PROBE_TIMEOUT_MS,
      );
      const parsed = probeSchema.safeParse(
        JSON.parse(unwrapJsonFences(extractMessageText(schemaRes.choices?.[0]?.message?.content))),
      );
      jsonSchema = parsed.success;
      structuredOutput = parsed.success;
    } catch {
      try {
        const completion = await this.complete({
          system: 'Return JSON with {"ok": true}.',
          prompt: 'ping',
          schema: probeSchema,
          maxOutputTokens: 48,
        });
        structuredOutput = probeSchema.safeParse(JSON.parse(completion.text)).success;
      } catch {
        structuredOutput = false;
      }
    }

    // 4. Probe tool calling support without failing the connection test if unsupported.
    let toolCalling = false;
    try {
      await this.postJson<OpenAiCompletionResponse>(
        '/chat/completions',
        {
          model: this.model,
          messages: [{ role: 'user', content: 'Say ok without calling any tool.' }],
          max_tokens: 16,
          tools: [
            {
              type: 'function',
              function: {
                name: 'noop_probe',
                description: 'Connectivity capability probe.',
                parameters: { type: 'object', properties: {}, additionalProperties: false },
              },
            },
          ],
        },
        undefined,
        PROBE_TIMEOUT_MS,
      );
      toolCalling = true;
    } catch {
      toolCalling = false;
    }

    return {
      resolvedModel,
      capabilities: {
        structuredOutput,
        jsonSchema,
        streaming: true,
        toolCalling,
        vision: false,
        modelsEndpoint,
      },
    };
  }

  private async streamChat(
    payload: Record<string, unknown>,
    fallbackModel: string,
    listener: AiConversationListener,
    signal?: AbortSignal,
  ): Promise<AiConversationReply> {
    const response = await this.send(
      '/chat/completions',
      { method: 'POST', body: JSON.stringify(payload) },
      signal,
    );
    if (!response.ok) {
      throw await this.readFailure(response);
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream') && response.body) {
      return parseOpenAiSseStream(response.body, fallbackModel, listener);
    }
    const data = (await response.json()) as OpenAiCompletionResponse;
    return this.toConversationReply(data, fallbackModel, listener);
  }

  private async postJson<ResponseType>(
    path: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = this.timeoutMs,
  ): Promise<ResponseType> {
    const response = await this.send(
      path,
      { method: 'POST', body: JSON.stringify(payload) },
      signal,
      timeoutMs,
    );
    if (!response.ok) {
      throw await this.readFailure(response);
    }
    return (await response.json()) as ResponseType;
  }

  private async send(
    path: string,
    init: { method: string; body?: string },
    signal?: AbortSignal,
    timeoutMs = this.timeoutMs,
  ): Promise<Response> {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const headers: Record<string, string> = {
      Accept: 'application/json, text/event-stream',
    };
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: init.method,
      headers,
      body: init.body,
      redirect: 'manual',
      signal: combinedSignal,
    });
    if (response.status >= HTTP_REDIRECT_MIN && response.status <= HTTP_REDIRECT_MAX) {
      throw {
        status: response.status,
        message: 'El servidor respondió con una redirección no permitida para credenciales API.',
      } satisfies HttpFailure;
    }
    return response;
  }

  private async readFailure(response: Response): Promise<HttpFailure> {
    let bodyText = '';
    try {
      bodyText = await response.text();
    } catch {
      bodyText = '';
    }
    return { status: response.status, message: extractErrorMessage(bodyText) };
  }

  private toCompletion(data: OpenAiCompletionResponse, fallbackModel: string): AiCompletion {
    const choice = data.choices?.[0];
    const message = choice?.message;
    if (message?.refusal) {
      return {
        text: '',
        model: data.model?.trim() || fallbackModel,
        stopReason: toOpenAiStopReason('content_filter'),
        usage: this.extractUsage(data),
      };
    }
    return {
      text: unwrapJsonFences(extractMessageText(message?.content)),
      model: data.model?.trim() || fallbackModel,
      stopReason: toOpenAiStopReason(choice?.finish_reason),
      usage: this.extractUsage(data),
    };
  }

  private toConversationReply(
    data: OpenAiCompletionResponse,
    fallbackModel: string,
    listener: AiConversationListener,
  ): AiConversationReply {
    const choice = data.choices?.[0];
    const message = choice?.message;
    const content: AiContentBlock[] = [];
    const text = extractMessageText(message?.content);
    if (text.length > 0) {
      listener.onTextDelta(text);
      content.push({ type: AiContentBlockType.Text, text });
    }
    for (const [index, call] of (message?.tool_calls ?? []).entries()) {
      const name = call.function?.name?.trim();
      if (!name) continue;
      content.push({
        type: AiContentBlockType.ToolUse,
        id: call.id?.trim() || `call_${index}`,
        name,
        input: parseToolArguments(call.function?.arguments ?? ''),
      });
    }
    return {
      content,
      model: data.model?.trim() || fallbackModel,
      stopReason: toOpenAiStopReason(choice?.finish_reason),
      usage: this.extractUsage(data),
    };
  }

  private extractUsage(data: OpenAiCompletionResponse): {
    inputTokens: number;
    outputTokens: number;
  } {
    return {
      inputTokens:
        typeof data.usage?.prompt_tokens === 'number' && data.usage.prompt_tokens >= 0
          ? data.usage.prompt_tokens
          : 0,
      outputTokens:
        typeof data.usage?.completion_tokens === 'number' && data.usage.completion_tokens >= 0
          ? data.usage.completion_tokens
          : 0,
    };
  }

  private isHttpFailure(error: unknown): error is HttpFailure {
    return (
      typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      typeof (error as HttpFailure).status === 'number'
    );
  }

  private isRecoverableFormatFailure(error: unknown): boolean {
    return this.isHttpFailure(error) && isFormatUnsupported(error);
  }

  private toConversationError(error: unknown): unknown {
    if (this.isHttpFailure(error) && isToolsUnsupported(error)) {
      return new AiOutputRejectedError(
        'the configured model does not support tool calling required by Agent Console',
      );
    }
    return this.toProviderError(error);
  }

  private toProviderError(error: unknown): unknown {
    if (isAbortError(error)) return error;
    if (this.isHttpFailure(error)) {
      this.logger.warn(`OpenAI-compatible request failed with status ${error.status}`);
      if (error.status === HTTP_UNAUTHORIZED || error.status === HTTP_FORBIDDEN) {
        return new AiKeyRejectedError();
      }
      return new AiProviderUnavailableError(error.status);
    }
    this.logger.warn('OpenAI-compatible request failed due to network or timeout error');
    return new AiProviderUnavailableError(undefined);
  }
}
