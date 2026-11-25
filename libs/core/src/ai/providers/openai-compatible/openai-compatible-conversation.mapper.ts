import type { AiConversationMessage, AiToolDefinition } from '../../entities/ai-conversation.js';
import { AiContentBlockType } from '../../enums/ai-content-block-type.enum.js';
import { AiConversationRole } from '../../enums/ai-conversation-role.enum.js';
import { AiStopReason } from '../../enums/ai-stop-reason.enum.js';

export interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export type OpenAiChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: OpenAiToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface OpenAiToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

const STOP_REASONS: Record<string, AiStopReason> = {
  stop: AiStopReason.Completed,
  tool_calls: AiStopReason.ToolUse,
  function_call: AiStopReason.ToolUse,
  length: AiStopReason.Truncated,
  content_filter: AiStopReason.Refused,
};

const CODE_FENCE_PATTERN = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i;

export function toOpenAiStopReason(reason: string | null | undefined): AiStopReason {
  if (!reason) return AiStopReason.Completed;
  return STOP_REASONS[reason] ?? AiStopReason.Completed;
}

/** Strips accidental ```json ... ``` fences when providers return prompt-guided JSON. */
export function unwrapJsonFences(text: string): string {
  const trimmed = text.trim();
  const match = CODE_FENCE_PATTERN.exec(trimmed);
  return match ? match[1].trim() : trimmed;
}

export function toOpenAiTools(tools: readonly AiToolDefinition[]): OpenAiToolSpec[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

/** Maps Crossmart provider-neutral conversation messages to OpenAI Chat Completions messages. */
export function toOpenAiMessages(
  system: string,
  messages: readonly AiConversationMessage[],
): OpenAiChatMessage[] {
  const mapped: OpenAiChatMessage[] = [];
  if (system.trim().length > 0) {
    mapped.push({ role: 'system', content: system });
  }

  for (const message of messages) {
    if (message.role === AiConversationRole.Assistant) {
      const textParts: string[] = [];
      const toolCalls: OpenAiToolCall[] = [];
      for (const block of message.content) {
        if (block.type === AiContentBlockType.Text) {
          textParts.push(block.text);
        } else if (block.type === AiContentBlockType.ToolUse) {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input ?? {}),
            },
          });
        }
      }
      const joined = textParts.join('');
      if (joined.length > 0 || toolCalls.length > 0) {
        mapped.push({
          role: 'assistant',
          content: joined.length > 0 ? joined : null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });
      }
      continue;
    }

    // User messages may hold tool_result blocks and/or plain text blocks.
    const userTexts: string[] = [];
    for (const block of message.content) {
      if (block.type === AiContentBlockType.ToolResult) {
        mapped.push({
          role: 'tool',
          tool_call_id: block.toolUseId,
          content: block.content,
        });
      } else if (block.type === AiContentBlockType.Text) {
        userTexts.push(block.text);
      }
    }
    if (userTexts.length > 0) {
      mapped.push({ role: 'user', content: userTexts.join('\n') });
    }
  }

  return mapped;
}

export function parseToolArguments(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}
