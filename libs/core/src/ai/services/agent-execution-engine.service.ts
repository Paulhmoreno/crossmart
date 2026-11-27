import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  AiContentBlock,
  AiConversationMessage,
  AiToolDefinition,
  AiToolUseBlock,
} from '../entities/ai-conversation.js';
import { AiContentBlockType } from '../enums/ai-content-block-type.enum.js';
import { AiConversationRole } from '../enums/ai-conversation-role.enum.js';
import type { AiFeature } from '../enums/ai-feature.enum.js';
import { AiGateway } from './ai-gateway.service.js';

const DEFAULT_MAX_STEPS = 6;
const DEFAULT_MAX_OUTPUT_TOKENS = 1400;
const DEFAULT_TOOL_TIMEOUT_MS = 25_000;
const MAX_TOOL_RESULT_CHARS = 12_000;
const TRANSIENT_RETRY_DELAY_MS = 800;

/** Detects unexpected CJK/Hangul characters that multilingual models sometimes leak into es/en text. */
const UNEXPECTED_FOREIGN_SCRIPT_RE = /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F\u4E00-\u9FFF\u3040-\u30FF]/g;
const RAW_TOOL_CALL_TAG_RE = /<tool_call>[\s\S]*?<\/tool_call>/gi;

export type AgentExecutionPhase =
  | 'thinking'
  | 'waiting_provider'
  | 'running_tool'
  | 'awaiting_approval'
  | 'cancelling';

export type AgentTurnFinalStatus = 'completed' | 'failed' | 'cancelled' | 'awaiting_approval';

export interface AgentToolRunRecord {
  id: string;
  toolName: string;
  title: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  outcome?: string;
  isError?: boolean;
}

export type AgentStreamEvent =
  | { type: 'turn_started'; turnId: string; agentKey: string; startedAt: string }
  | { type: 'status'; phase: AgentExecutionPhase; detail?: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_started'; tool: AgentToolRunRecord }
  | { type: 'tool_finished'; tool: AgentToolRunRecord }
  | { type: 'error'; code: string; message: string }
  | {
      type: 'turn_finished';
      turnId: string;
      status: AgentTurnFinalStatus;
      text: string;
      toolsUsed: string[];
      toolRuns: AgentToolRunRecord[];
      error?: string;
    };

export interface AgentStreamSink {
  emit(event: AgentStreamEvent): void;
}

export interface ExecutableAgentTool {
  definition: AiToolDefinition;
  /** Human-readable commercial title (localized by frontend via i18n). */
  title: string;
  timeoutMs?: number;
  execute(
    input: Record<string, unknown>,
    ctx: { signal: AbortSignal },
  ): Promise<{
    output: unknown;
    outcome?: string;
    isError?: boolean;
    awaitingApproval?: boolean;
  }>;
}

export interface AgentExecutionRequest {
  workspaceId: string;
  agentKey: string;
  feature: AiFeature;
  conversationKey: string;
  systemPrompt: string;
  locale?: string | null;
  messages: AiConversationMessage[];
  tools: ExecutableAgentTool[];
  maxSteps?: number;
  maxOutputTokens?: number;
  externalSignal?: AbortSignal;
  fallbackText?: string;
}

export interface AgentExecutionResult {
  turnId: string;
  status: AgentTurnFinalStatus;
  text: string;
  toolsUsed: string[];
  toolRuns: AgentToolRunRecord[];
  error?: string;
}

export function buildLocalePolicyPrompt(locale?: string | null): string {
  const normalized = (locale ?? 'es-EC').toLowerCase();
  if (normalized.startsWith('en')) {
    return [
      'STRICT LANGUAGE POLICY:',
      '- Respond strictly in clear, natural English unless the user explicitly asks for another language.',
      '- NEVER mix unrelated foreign scripts or words (such as Korean, Chinese, Japanese, or Cyrillic) into your response.',
      '- Preserve brand names, SKUs, URLs, and necessary technical terms only when appropriate.',
      '- NEVER write fake tool execution text like "Executing: ..." in plain text; actually call the provided tools or explain clearly if a tool is unavailable.',
    ].join('\n');
  }
  return [
    'POLÍTICA ESTRICTA DE IDIOMA:',
    '- Responde estrictamente en español natural (Ecuador, es-EC), salvo que el usuario solicite expresamente otro idioma.',
    '- NUNCA mezcles caracteres ni palabras de otros idiomas o escrituras (como coreano, chino, japonés o cirílico).',
    '- Conserva nombres reales de marcas, SKUs, URLs o términos técnicos solo cuando sea necesario.',
    '- NUNCA simules ejecuciones de herramientas escribiendo texto como "Ejecutando: ..."; invoca realmente las herramientas provistas o explica con claridad si una herramienta no está disponible.',
  ].join('\n');
}

export function sanitizeUnexpectedScripts(text: string, locale?: string | null): string {
  let cleaned = text.replace(RAW_TOOL_CALL_TAG_RE, '');
  const normalized = (locale ?? 'es-EC').toLowerCase();
  if (!normalized.startsWith('es') && !normalized.startsWith('en')) return cleaned;
  if (!UNEXPECTED_FOREIGN_SCRIPT_RE.test(cleaned)) return cleaned;
  UNEXPECTED_FOREIGN_SCRIPT_RE.lastIndex = 0;
  return cleaned.replace(UNEXPECTED_FOREIGN_SCRIPT_RE, '').replace(/[ \t]{2,}/g, ' ');
}

function isToolUse(block: AiContentBlock): block is AiToolUseBlock {
  return block.type === AiContentBlockType.ToolUse;
}

function extractText(blocks: readonly AiContentBlock[]): string {
  return blocks
    .flatMap((block) => (block.type === AiContentBlockType.Text ? [block.text] : []))
    .join('')
    .trim();
}

function isTransientProviderError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /(429|502|503|504|ECONNRESET|ETIMEDOUT|overloaded|rate limit|temporarily)/i.test(msg);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
  label: string,
): Promise<T> {
  if (signal.aborted) {
    throw new Error('Cancelled');
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout after ${Math.round(timeoutMs / 1000)}s while executing ${label}`));
    }, timeoutMs);

    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Cancelled'));
    };
    signal.addEventListener('abort', onAbort, { once: true });

    promise.then(
      (value) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

function stringifyToolOutput(output: unknown): string {
  let raw: string;
  try {
    raw = typeof output === 'string' ? output : JSON.stringify(output);
  } catch {
    raw = String(output);
  }
  if (raw.length <= MAX_TOOL_RESULT_CHARS) return raw;
  return `${raw.slice(0, MAX_TOOL_RESULT_CHARS)}... [truncated]`;
}

/**
 * Shared General Agent Execution Engine for Crossmart agents (`sales`, `social`, and future agents),
 * aligned with `AgentWorkerLoop`'s exact streaming, tool-calling, cancellation, concurrency,
 * timeout, and locale discipline contract.
 */
@Injectable()
export class AgentExecutionEngine {
  private readonly logger = new Logger(AgentExecutionEngine.name);
  private readonly activeTurns = new Map<string, AbortController>();
  private readonly activeConversations = new Map<string, string>();

  constructor(private readonly ai: AiGateway) {}

  /** Requests cancellation of an active turn by turnId. Returns true if an active turn was signalled. */
  cancelTurn(turnId: string): boolean {
    const controller = this.activeTurns.get(turnId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  /** Returns active turnId for a conversation key, if any. */
  getActiveTurnId(conversationKey: string): string | null {
    return this.activeConversations.get(conversationKey) ?? null;
  }

  async runTurn(
    req: AgentExecutionRequest,
    sink?: AgentStreamSink,
  ): Promise<AgentExecutionResult> {
    if (this.activeConversations.has(req.conversationKey)) {
      throw new ConflictException(
        'Another execution is already in progress for this conversation. Wait for it to finish or cancel it first.',
      );
    }

    const turnId = randomUUID();
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    if (req.externalSignal) {
      if (req.externalSignal.aborted) controller.abort();
      else req.externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    this.activeTurns.set(turnId, controller);
    this.activeConversations.set(req.conversationKey, turnId);

    const emit = (event: AgentStreamEvent) => {
      try {
        sink?.emit(event);
      } catch {
        // Ignore sink write errors after client disconnect.
      }
    };

    const toolsByName = new Map(req.tools.map((tool) => [tool.definition.name, tool]));
    const toolDefinitions = req.tools.map((tool) => tool.definition);
    const maxSteps = req.maxSteps ?? DEFAULT_MAX_STEPS;
    const maxOutputTokens = req.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    const fullSystem = `${req.systemPrompt}\n\n${buildLocalePolicyPrompt(req.locale)}`;
    const messages: AiConversationMessage[] = [...req.messages];
    const toolsUsed: string[] = [];
    const toolRuns: AgentToolRunRecord[] = [];
    let finalText = '';
    let lastStepHadTools = false;
    let awaitingApproval = false;

    emit({
      type: 'turn_started',
      turnId,
      agentKey: req.agentKey,
      startedAt: new Date().toISOString(),
    });

    try {
      for (let step = 0; step < maxSteps; step += 1) {
        if (controller.signal.aborted) {
          return this.finish(emit, turnId, 'cancelled', finalText, toolsUsed, toolRuns);
        }

        emit({ type: 'status', phase: 'waiting_provider' });

        const turn = await this.callModelWithSafeRetry(
          req,
          fullSystem,
          messages,
          toolDefinitions,
          maxOutputTokens,
          controller.signal,
          (delta) => {
            const clean = sanitizeUnexpectedScripts(delta, req.locale);
            if (clean) emit({ type: 'text_delta', delta: clean });
          },
        );

        const stepText = sanitizeUnexpectedScripts(extractText(turn.content), req.locale);
        const calls = turn.content.filter(isToolUse);

        if (calls.length === 0) {
          finalText = stepText;
          lastStepHadTools = false;
          break;
        }

        lastStepHadTools = true;
        messages.push({ role: AiConversationRole.Assistant, content: turn.content });
        const resultBlocks: AiContentBlock[] = [];

        for (const call of calls) {
          if (controller.signal.aborted) {
            const cancelledRun: AgentToolRunRecord = {
              id: call.id,
              toolName: call.name,
              title: toolsByName.get(call.name)?.title ?? call.name,
              status: 'cancelled',
            };
            toolRuns.push(cancelledRun);
            emit({ type: 'tool_finished', tool: cancelledRun });
            return this.finish(emit, turnId, 'cancelled', finalText, toolsUsed, toolRuns);
          }

          const tool = toolsByName.get(call.name);
          const title = tool?.title ?? call.name;
          const runRecord: AgentToolRunRecord = {
            id: call.id,
            toolName: call.name,
            title,
            status: 'running',
          };
          toolsUsed.push(call.name);
          toolRuns.push(runRecord);
          emit({ type: 'tool_started', tool: { ...runRecord } });
          emit({ type: 'status', phase: 'running_tool', detail: title });

          if (!tool) {
            runRecord.status = 'failed';
            runRecord.isError = true;
            runRecord.outcome = 'Tool not available';
            emit({ type: 'tool_finished', tool: { ...runRecord } });
            resultBlocks.push({
              type: AiContentBlockType.ToolResult,
              toolUseId: call.id,
              content: JSON.stringify({
                error: `Tool "${call.name}" is not available for this agent.`,
              }),
              isError: true,
            });
            continue;
          }

          try {
            const exec = await withTimeout(
              tool.execute(call.input, { signal: controller.signal }),
              tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
              controller.signal,
              title,
            );
            runRecord.status = exec.isError ? 'failed' : 'succeeded';
            runRecord.isError = Boolean(exec.isError);
            runRecord.outcome = exec.outcome;
            if (exec.awaitingApproval) awaitingApproval = true;
            emit({ type: 'tool_finished', tool: { ...runRecord } });
            resultBlocks.push({
              type: AiContentBlockType.ToolResult,
              toolUseId: call.id,
              content: stringifyToolOutput(exec.output),
              isError: Boolean(exec.isError),
            });
          } catch (toolError) {
            const errMsg = toolError instanceof Error ? toolError.message : String(toolError);
            const wasCancelled = controller.signal.aborted || errMsg === 'Cancelled';
            runRecord.status = wasCancelled ? 'cancelled' : 'failed';
            runRecord.isError = !wasCancelled;
            runRecord.outcome = wasCancelled ? undefined : errMsg.slice(0, 140);
            emit({ type: 'tool_finished', tool: { ...runRecord } });
            if (wasCancelled) {
              return this.finish(emit, turnId, 'cancelled', finalText, toolsUsed, toolRuns);
            }
            this.logger.warn(`Agent ${req.agentKey} tool ${call.name} failed: ${errMsg}`);
            resultBlocks.push({
              type: AiContentBlockType.ToolResult,
              toolUseId: call.id,
              content: JSON.stringify({ error: errMsg }),
              isError: true,
            });
          }
        }

        messages.push({ role: AiConversationRole.User, content: resultBlocks });
      }

      // If the model finished maxSteps immediately after running tools (without final text),
      // run one final synthesis pass with tools=[] so the user always gets a grounded answer.
      if (lastStepHadTools && !finalText && !controller.signal.aborted) {
        emit({ type: 'status', phase: 'waiting_provider' });
        const synthesis = await this.callModelWithSafeRetry(
          req,
          fullSystem,
          messages,
          [],
          maxOutputTokens,
          controller.signal,
          (delta) => {
            const clean = sanitizeUnexpectedScripts(delta, req.locale);
            if (clean) emit({ type: 'text_delta', delta: clean });
          },
        );
        finalText = sanitizeUnexpectedScripts(extractText(synthesis.content), req.locale);
      }

      const resolvedText = finalText || req.fallbackText || '';
      const status: AgentTurnFinalStatus = awaitingApproval ? 'awaiting_approval' : 'completed';
      if (awaitingApproval) {
        emit({ type: 'status', phase: 'awaiting_approval' });
      }
      return this.finish(emit, turnId, status, resolvedText, toolsUsed, toolRuns);
    } catch (error) {
      if (controller.signal.aborted) {
        return this.finish(emit, turnId, 'cancelled', finalText, toolsUsed, toolRuns);
      }
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Agent ${req.agentKey} turn ${turnId} failed: ${message}`);
      emit({ type: 'error', code: 'execution_failed', message });
      return this.finish(emit, turnId, 'failed', finalText, toolsUsed, toolRuns, message);
    } finally {
      if (req.externalSignal) {
        req.externalSignal.removeEventListener('abort', onExternalAbort);
      }
      this.activeTurns.delete(turnId);
      if (this.activeConversations.get(req.conversationKey) === turnId) {
        this.activeConversations.delete(req.conversationKey);
      }
    }
  }

  private async callModelWithSafeRetry(
    req: AgentExecutionRequest,
    system: string,
    messages: AiConversationMessage[],
    tools: AiToolDefinition[],
    maxOutputTokens: number,
    signal: AbortSignal,
    onTextDelta: (delta: string) => void,
  ) {
    let streamedAny = false;
    const listener = {
      onTextDelta: (delta: string) => {
        streamedAny = true;
        onTextDelta(delta);
      },
    };
    try {
      return await this.ai.converse(
        { workspaceId: req.workspaceId, feature: req.feature, agentKey: req.agentKey },
        { system, messages, tools, maxOutputTokens, signal },
        listener,
      );
    } catch (firstError) {
      if (signal.aborted || streamedAny || !isTransientProviderError(firstError)) {
        throw firstError;
      }
      await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_DELAY_MS));
      if (signal.aborted) throw firstError;
      return this.ai.converse(
        { workspaceId: req.workspaceId, feature: req.feature, agentKey: req.agentKey },
        { system, messages, tools, maxOutputTokens, signal },
        listener,
      );
    }
  }

  private finish(
    emit: (event: AgentStreamEvent) => void,
    turnId: string,
    status: AgentTurnFinalStatus,
    text: string,
    toolsUsed: string[],
    toolRuns: AgentToolRunRecord[],
    error?: string,
  ): AgentExecutionResult {
    emit({ type: 'turn_finished', turnId, status, text, toolsUsed, toolRuns, error });
    return { turnId, status, text, toolsUsed, toolRuns, error };
  }
}
