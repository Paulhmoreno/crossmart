import type {
  AiContentBlock,
  AiConversationListener,
  AiConversationReply,
} from '../../entities/ai-conversation.js';
import { AiContentBlockType } from '../../enums/ai-content-block-type.enum.js';
import { AiStopReason } from '../../enums/ai-stop-reason.enum.js';
import { parseToolArguments, toOpenAiStopReason } from './openai-compatible-conversation.mapper.js';

interface StreamToolCallDelta {
  index?: number;
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface StreamChunk {
  model?: string;
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: StreamToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  } | null;
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
}

interface StreamState {
  model: string;
  text: string;
  stopReason: AiStopReason;
  hasFinishReason: boolean;
  inputTokens: number;
  outputTokens: number;
  toolCalls: Map<number, ToolCallAccumulator>;
}

function applyChunk(
  chunk: StreamChunk,
  state: StreamState,
  listener: AiConversationListener,
): void {
  if (chunk.model) state.model = chunk.model;
  if (chunk.usage) {
    if (typeof chunk.usage.prompt_tokens === 'number') {
      state.inputTokens = chunk.usage.prompt_tokens;
    }
    if (typeof chunk.usage.completion_tokens === 'number') {
      state.outputTokens = chunk.usage.completion_tokens;
    }
  }
  const choice = chunk.choices?.[0];
  if (!choice) return;
  if (typeof choice.delta?.content === 'string' && choice.delta.content.length > 0) {
    state.text += choice.delta.content;
    listener.onTextDelta(choice.delta.content);
  }
  for (const callDelta of choice.delta?.tool_calls ?? []) {
    const index = callDelta.index ?? 0;
    const current = state.toolCalls.get(index) ?? {
      id: callDelta.id ?? `call_${index}`,
      name: '',
      arguments: '',
    };
    if (callDelta.id) current.id = callDelta.id;
    if (callDelta.function?.name) current.name += callDelta.function.name;
    if (callDelta.function?.arguments) current.arguments += callDelta.function.arguments;
    state.toolCalls.set(index, current);
  }
  if (choice.finish_reason) {
    state.stopReason = toOpenAiStopReason(choice.finish_reason);
    state.hasFinishReason = true;
  }
}

function finalizeReply(state: StreamState): AiConversationReply {
  const content: AiContentBlock[] = [];
  if (state.text.length > 0) {
    content.push({ type: AiContentBlockType.Text, text: state.text });
  }
  const orderedTools = [...state.toolCalls.entries()].sort(([left], [right]) => left - right);
  for (const [, call] of orderedTools) {
    if (!call.name) continue;
    content.push({
      type: AiContentBlockType.ToolUse,
      id: call.id,
      name: call.name,
      input: parseToolArguments(call.arguments),
    });
  }
  const stopReason =
    !state.hasFinishReason && orderedTools.length > 0 ? AiStopReason.ToolUse : state.stopReason;
  return {
    content,
    model: state.model,
    stopReason,
    usage: { inputTokens: state.inputTokens, outputTokens: state.outputTokens },
  };
}

/** Consumes an OpenAI Chat Completions SSE stream and emits text deltas incrementally. */
export async function parseOpenAiSseStream(
  body: ReadableStream<Uint8Array>,
  fallbackModel: string,
  listener: AiConversationListener,
): Promise<AiConversationReply> {
  const state: StreamState = {
    model: fallbackModel,
    text: '',
    stopReason: AiStopReason.Completed,
    hasFinishReason: false,
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: new Map(),
  };

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const SSE_DATA_PREFIX = 'data:';
  const SSE_DATA_PREFIX_LENGTH = SSE_DATA_PREFIX.length;

  const processLine = (rawLine: string) => {
    const line = rawLine.trim();
    if (!line.startsWith(SSE_DATA_PREFIX)) return;
    const payload = line.slice(SSE_DATA_PREFIX_LENGTH).trim();
    if (!payload || payload === '[DONE]') return;
    try {
      const parsed = JSON.parse(payload) as StreamChunk;
      applyChunk(parsed, state, listener);
    } catch {
      // Ignore partial or non-JSON keepalive frames.
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) processLine(line);
    }
    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      for (const line of buffer.split(/\r?\n/)) processLine(line);
    }
  } finally {
    reader.releaseLock();
  }

  return finalizeReply(state);
}
