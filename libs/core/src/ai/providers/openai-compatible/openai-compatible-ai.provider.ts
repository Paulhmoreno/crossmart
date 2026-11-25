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
const PROBE_TIMEOUT_MS = 45_000;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_METHOD_NOT_ALLOWED = 405;
const HTTP_UNPROCESSABLE = 422;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_NOT_IMPLEMENTED = 501;
const HTTP_REDIRECT_MIN = 300;
const HTTP_REDIRECT_MAX = 399;
const MAX_ERROR_BODY_CHARS = 300;

export class AiDiagnosticError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiDiagnosticError';
  }
}

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

const SSE_LINE_PREFIX = 'data:';
const SSE_LINE_PREFIX_LEN = SSE_LINE_PREFIX.length;

function parseCompletionPayloadText(
  rawText: string,
  fallbackModel: string,
): OpenAiCompletionResponse {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return { model: fallbackModel, choices: [] };
  }
  // Some OpenAI-compatible gateways return SSE (`data: {...}`) or NDJSON even on stream:false.
  if (trimmed.startsWith(SSE_LINE_PREFIX) || trimmed.includes(`\n${SSE_LINE_PREFIX}`)) {
    let model = fallbackModel;
    let text = '';
    let finishReason: string | null = null;
    let promptTokens = 0;
    let completionTokens = 0;
    for (const rawLine of trimmed.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line.startsWith(SSE_LINE_PREFIX)) continue;
      const body = line.slice(SSE_LINE_PREFIX_LEN).trim();
      if (!body || body === '[DONE]') continue;
      try {
        const chunk = JSON.parse(body) as {
          model?: string;
          choices?: Array<{
            delta?: { content?: string | null };
            message?: { content?: string | null };
            finish_reason?: string | null;
          }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
        };
        if (chunk.model) model = chunk.model;
        const choice = chunk.choices?.[0];
        const piece = choice?.delta?.content ?? choice?.message?.content;
        if (typeof piece === 'string') text += piece;
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (typeof chunk.usage?.prompt_tokens === 'number')
          promptTokens = chunk.usage.prompt_tokens;
        if (typeof chunk.usage?.completion_tokens === 'number') {
          completionTokens = chunk.usage.completion_tokens;
        }
      } catch {
        // Ignore keepalive or partial SSE lines.
      }
    }
    return {
      model,
      choices: [{ message: { content: text }, finish_reason: finishReason }],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
    };
  }
  // Handle single JSON object or trailing newline / concatenated JSON objects gracefully.
  try {
    return JSON.parse(trimmed) as OpenAiCompletionResponse;
  } catch {
    const firstLine = trimmed.split(/\r?\n/).find((line) => line.trim().startsWith('{'));
    if (firstLine) {
      return JSON.parse(firstLine) as OpenAiCompletionResponse;
    }
    throw new Error('La respuesta del servidor no es JSON válido.');
  }
}

function isToolsUnsupported(failure: HttpFailure): boolean {
  if (failure.status !== HTTP_BAD_REQUEST && failure.status !== HTTP_UNPROCESSABLE) return false;
  return /tool|function|does not support tools|not supported/i.test(failure.message);
}

function needsMaxCompletionTokens(failure: HttpFailure): boolean {
  if (failure.status !== HTTP_BAD_REQUEST && failure.status !== HTTP_UNPROCESSABLE) return false;
  return /max_completion_tokens/i.test(failure.message);
}

function swapMaxTokensField(payload: Record<string, unknown>): Record<string, unknown> {
  if (!('max_tokens' in payload)) return payload;
  const { max_tokens: maxTokens, ...rest } = payload;
  return { ...rest, max_completion_tokens: maxTokens };
}

function describeNetworkError(error: unknown, baseUrl: string): string {
  const host = URL.canParse(baseUrl) ? new URL(baseUrl).host : baseUrl;
  if (error instanceof Error && error.name === 'TimeoutError') {
    return `Tiempo de espera agotado al conectar con ${host}.`;
  }
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: { code?: string; message?: string } }).cause;
    const code = cause?.code ?? cause?.message ?? error.message;
    return `No se pudo conectar con ${host} (${String(code).slice(0, MAX_ERROR_BODY_CHARS)}). Verifica la URL base y la conectividad de red.`;
  }
  return `No se pudo conectar con ${host}.`;
}

function describeHttpFailure(failure: HttpFailure): string {
  const detail = failure.message ? `: ${failure.message}` : '';
  if (failure.status === HTTP_UNAUTHORIZED || failure.status === HTTP_FORBIDDEN) {
    return `El proveedor rechazó la API Key (HTTP ${failure.status})${detail}`;
  }
  if (failure.status === HTTP_NOT_FOUND) {
    return `Endpoint o modelo no encontrado (HTTP 404)${detail}. Verifica que la URL base incluya el prefijo correcto (ej. /v1) y el nombre exacto del modelo.`;
  }
  if (failure.status === HTTP_TOO_MANY_REQUESTS) {
    return `Límite de peticiones o cuota excedida en el proveedor (HTTP 429)${detail}`;
  }
  return `El proveedor respondió HTTP ${failure.status}${detail}`;
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
      const response = await this.send(
        '/models',
        { method: 'GET', accept: 'application/json' },
        undefined,
        PROBE_TIMEOUT_MS,
      );
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
      throw new AiDiagnosticError(this.describeDiagnosticError(error));
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
        max_tokens: 256,
      },
      undefined,
      PROBE_TIMEOUT_MS,
    ).catch((error) => {
      throw new AiDiagnosticError(this.describeDiagnosticError(error));
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
          max_tokens: 256,
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
          maxOutputTokens: 256,
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
          max_tokens: 128,
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
    let response = await this.send(
      '/chat/completions',
      { method: 'POST', body: JSON.stringify(payload) },
      signal,
    );
    if (!response.ok) {
      const failure = await this.readFailure(response);
      if (needsMaxCompletionTokens(failure) && 'max_tokens' in payload) {
        response = await this.send(
          '/chat/completions',
          { method: 'POST', body: JSON.stringify(swapMaxTokensField(payload)) },
          signal,
        );
        if (!response.ok) throw await this.readFailure(response);
      } else {
        throw failure;
      }
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
    const bodyPayload =
      path === '/chat/completions' && payload.stream === undefined
        ? { ...payload, stream: false }
        : payload;
    const response = await this.send(
      path,
      { method: 'POST', body: JSON.stringify(bodyPayload), accept: 'application/json' },
      signal,
      timeoutMs,
    );
    if (!response.ok) {
      const failure = await this.readFailure(response);
      if (needsMaxCompletionTokens(failure) && 'max_tokens' in bodyPayload) {
        const retryResponse = await this.send(
          path,
          {
            method: 'POST',
            body: JSON.stringify(swapMaxTokensField(bodyPayload)),
            accept: 'application/json',
          },
          signal,
          timeoutMs,
        );
        if (!retryResponse.ok) {
          throw await this.readFailure(retryResponse);
        }
        const retryText = await retryResponse.text();
        return parseCompletionPayloadText(retryText, this.model) as ResponseType;
      }
      throw failure;
    }
    const rawText = await response.text();
    return parseCompletionPayloadText(rawText, this.model) as ResponseType;
  }

  private async send(
    path: string,
    init: { method: string; body?: string; accept?: string },
    signal?: AbortSignal,
    timeoutMs = this.timeoutMs,
  ): Promise<Response> {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const headers: Record<string, string> = {
      Accept: init.accept ?? 'application/json, text/event-stream',
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

  /** Returns a safe, human-readable diagnostic message for connection tests without leaking secrets. */
  describeDiagnosticError(error: unknown): string {
    if (this.isHttpFailure(error)) {
      this.logger.warn(`OpenAI-compatible probe failed with HTTP ${error.status}`);
      return describeHttpFailure(error);
    }
    const networkMsg = describeNetworkError(error, this.baseUrl);
    this.logger.warn(`OpenAI-compatible probe network error: ${networkMsg}`);
    return networkMsg;
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
    const reason = describeNetworkError(error, this.baseUrl);
    this.logger.warn(`OpenAI-compatible request failed: ${reason}`);
    return new AiProviderUnavailableError(undefined);
  }
}
