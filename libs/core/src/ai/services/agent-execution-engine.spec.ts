import { describe, expect, it, vi } from 'vitest';
import { AiContentBlockType } from '../enums/ai-content-block-type.enum.js';
import { AiConversationRole } from '../enums/ai-conversation-role.enum.js';
import { AiFeature } from '../enums/ai-feature.enum.js';
import { AiStopReason } from '../enums/ai-stop-reason.enum.js';
import {
  AgentExecutionEngine,
  type AgentStreamEvent,
  sanitizeUnexpectedScripts,
} from './agent-execution-engine.service.js';
import type { AiGateway } from './ai-gateway.service.js';

function makeAiMock(replies: Array<{ text?: string; toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }> }>) {
  let idx = 0;
  return {
    converse: vi.fn(async (_ctx, _req, listener) => {
      const next = replies[idx] ?? { text: 'Final fallback' };
      idx += 1;
      const content = [];
      if (next.text) {
        listener?.onTextDelta?.(next.text);
        content.push({ type: AiContentBlockType.Text, text: next.text });
      }
      for (const tc of next.toolCalls ?? []) {
        content.push({
          type: AiContentBlockType.ToolUse,
          id: tc.id,
          name: tc.name,
          input: tc.input,
        });
      }
      return {
        model: 'test-model',
        stopReason: next.toolCalls?.length ? AiStopReason.ToolUse : AiStopReason.EndTurn,
        content,
        usage: { inputTokens: 10, outputTokens: 10 },
      };
    }),
  } as unknown as AiGateway;
}

describe('AgentExecutionEngine', () => {
  it('executes consecutive tools, delivers results to the model, and streams final answer', async () => {
    const ai = makeAiMock([
      { toolCalls: [{ id: 'tc-1', name: 'tool_a', input: {} }] },
      { toolCalls: [{ id: 'tc-2', name: 'tool_b', input: { x: 1 } }] },
      { text: 'Todo verificado correctamente.' },
    ]);
    const engine = new AgentExecutionEngine(ai);
    const events: AgentStreamEvent[] = [];

    const result = await engine.runTurn(
      {
        workspaceId: 'ws-1',
        agentKey: 'social',
        feature: AiFeature.SalesAgent,
        conversationKey: 'ws-1:social:conv-1',
        systemPrompt: 'You are a test agent.',
        locale: 'es-EC',
        messages: [
          { role: AiConversationRole.User, content: [{ type: AiContentBlockType.Text, text: 'Revisa' }] },
        ],
        tools: [
          {
            title: 'Tool A',
            definition: { name: 'tool_a', description: 'A', inputSchema: { type: 'object', properties: {} } },
            execute: async () => ({ output: { ok: true }, outcome: 'A done' }),
          },
          {
            title: 'Tool B',
            definition: { name: 'tool_b', description: 'B', inputSchema: { type: 'object', properties: {} } },
            execute: async () => ({ output: { count: 2 }, outcome: 'B done' }),
          },
        ],
      },
      { emit: (e) => events.push(e) },
    );

    expect(result.status).toBe('completed');
    expect(result.text).toBe('Todo verificado correctamente.');
    expect(result.toolsUsed).toEqual(['tool_a', 'tool_b']);
    expect(events.some((e) => e.type === 'tool_started')).toBe(true);
    expect(events.some((e) => e.type === 'tool_finished')).toBe(true);
    expect(events.some((e) => e.type === 'turn_finished')).toBe(true);
  });

  it('runs a final synthesis step when maxSteps ends right after a tool call', async () => {
    const ai = makeAiMock([
      { toolCalls: [{ id: 'tc-1', name: 'slow_read', input: {} }] },
      { text: 'Resumen final tras herramienta.' },
    ]);
    const engine = new AgentExecutionEngine(ai);
    const result = await engine.runTurn({
      workspaceId: 'ws-1',
      agentKey: 'social',
      feature: AiFeature.SalesAgent,
      conversationKey: 'ws-1:social:conv-synth',
      systemPrompt: 'Test',
      locale: 'es-EC',
      maxSteps: 1,
      messages: [
        { role: AiConversationRole.User, content: [{ type: AiContentBlockType.Text, text: 'Go' }] },
      ],
      tools: [
        {
          title: 'Slow read',
          definition: { name: 'slow_read', description: 'R', inputSchema: { type: 'object', properties: {} } },
          execute: async () => ({ output: { accounts: 1 } }),
        },
      ],
    });

    expect(result.status).toBe('completed');
    expect(result.text).toBe('Resumen final tras herramienta.');
    expect(result.toolsUsed).toEqual(['slow_read']);
  });

  it('handles per-tool timeout gracefully and lets the model recover', async () => {
    const ai = makeAiMock([
      { toolCalls: [{ id: 'tc-1', name: 'hanging_tool', input: {} }] },
      { text: 'La herramienta externa excedió el tiempo de espera.' },
    ]);
    const engine = new AgentExecutionEngine(ai);
    const result = await engine.runTurn({
      workspaceId: 'ws-1',
      agentKey: 'social',
      feature: AiFeature.SalesAgent,
      conversationKey: 'ws-1:social:conv-timeout',
      systemPrompt: 'Test',
      locale: 'es-EC',
      messages: [
        { role: AiConversationRole.User, content: [{ type: AiContentBlockType.Text, text: 'Check' }] },
      ],
      tools: [
        {
          title: 'External API',
          timeoutMs: 30,
          definition: { name: 'hanging_tool', description: 'H', inputSchema: { type: 'object', properties: {} } },
          execute: () => new Promise(() => undefined),
        },
      ],
    });

    expect(result.status).toBe('completed');
    expect(result.toolRuns[0]?.status).toBe('failed');
    expect(result.text).toContain('excedió el tiempo de espera');
  });

  it('sanitizes unexpected Korean/CJK scripts in es-EC and en text while preserving normal text', () => {
    const dirty = 'Conectado con TryPost 안녕하세요 y 3 cuentas activas.';
    expect(sanitizeUnexpectedScripts(dirty, 'es-EC')).toBe('Conectado con TryPost y 3 cuentas activas.');
    expect(sanitizeUnexpectedScripts('Audio-Technica AT-LP60X $199', 'en')).toBe(
      'Audio-Technica AT-LP60X $199',
    );
  });
});
