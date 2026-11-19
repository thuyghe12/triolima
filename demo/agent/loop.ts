/**
 * The agent loop — where Triolima meets a real model.
 *
 * We own the loop, so we instrument it directly: every hop (input, tool_call,
 * tool_result, output) is `observe`d into memory, Tier 2 runs at each, and the
 * prompt the model sees is NOT the full transcript — it is whatever `assemble`
 * discloses. That is the whole demonstration: the agent stays sharp across a
 * long incident because memory, not history, feeds it, and the token meter shows
 * the gap. A mitigation that memory flags as irreversible pauses for a human.
 *
 * The loop is transport-agnostic: it emits events and awaits `askHuman`. The
 * server wires those to a WebSocket; tests wire them to arrays and auto-answers.
 */
import {
  createMemory, estimateTokens, rankHot, hybridRetrieve,
  type Memory, type Card, type Answer,
} from '../../src/index';
import type { ModelProvider, ApiMessage, ToolCall } from './provider';
import { MEMORY_CONFIG, SYSTEM } from './config';
import { TOOL_SPECS, MUTATING, executeTool } from './tools';

export interface EventRow { actor: string; op: string; summary: string; at: number; id: string }
export interface FactRow {
  id: string; kind: 'pin' | 'verified'; text: string;
  rubric?: string | undefined; confidence?: number | undefined;
  weight: number; lastUsed: number; uses: number; sourceTurn: number;
}
export interface MemorySnapshot {
  turn: number;
  events: EventRow[];
  facts: FactRow[];
  header: { id: string; kind: string; text: string; score: number | null }[];
  retrieved: { id: string; text: string; relevance: number }[];
  archiveSize: number;
  memoryTokens: number;
  /** What a naive full-history prompt would cost by now — the baseline. */
  naiveTokens: number;
}

export type LoopEvent =
  | { kind: 'assistant'; text: string }
  | { kind: 'tool_call'; name: string; input: Record<string, unknown> }
  | { kind: 'tool_result'; name: string; output: string }
  | { kind: 'memory'; snapshot: MemorySnapshot }
  | { kind: 'card'; card: Card }
  | { kind: 'notice'; text: string }
  | { kind: 'done'; usage: { input: number; output: number } }
  | { kind: 'error'; message: string };

export type AskHuman = (card: Card) => Promise<{ answer: Answer; text?: string }>;

export interface SessionDeps {
  provider: ModelProvider;
  emit: (e: LoopEvent) => void;
  askHuman: AskHuman;
  /** Cost cap: model calls per user message. */
  maxModelCalls?: number;
}

export interface Session {
  readonly memory: Memory;
  say: (userText: string) => Promise<void>;
}

const SCAFFOLD_TOKENS = 40;

function toolResultBlock(id: string, content: string): unknown {
  return { type: 'tool_result', tool_use_id: id, content };
}

export function createSession(deps: SessionDeps): Session {
  const memory = createMemory(MEMORY_CONFIG);
  const maxCalls = deps.maxModelCalls ?? 8;
  let naiveTokens = 0; // grows with every hop — the full-history baseline

  // A read-only view of memory for the UI: never commits or touches, so emitting
  // it freely does not pollute the audit tree (the real assemble does that once
  // per model call).
  function snapshot(query: string): MemorySnapshot {
    const all = memory.store.all();
    const header = rankHot(all, MEMORY_CONFIG.budget, memory.turn());
    const inHeader = new Set(header.map((f) => f.id));
    const retrieved = hybridRetrieve(query, all.filter((f) => !inHeader.has(f.id)), MEMORY_CONFIG.budget.retrieveK);
    const memoryTokens =
      header.reduce((t, f) => t + estimateTokens(f.text), 0) +
      retrieved.reduce((t, f) => t + estimateTokens(f.text), 0) + SCAFFOLD_TOKENS;
    return {
      turn: memory.turn(),
      events: memory.tree.log().map((e) => ({ id: e.id.slice(0, 8), actor: e.actor, op: e.op, summary: e.summary, at: e.at })),
      facts: all.map((f) => ({
        id: f.id.slice(0, 8), kind: f.kind, text: f.text, rubric: f.rubric, confidence: f.confidence,
        weight: f.weight, lastUsed: f.lastUsed, uses: f.uses, sourceTurn: f.sourceTurn,
      })),
      header: header.map((f) => ({ id: f.id.slice(0, 8), kind: f.kind, text: f.text, score: Number.isFinite(f.score) ? f.score : null })),
      retrieved: retrieved.map((f) => ({ id: f.id.slice(0, 8), text: f.text, relevance: f.relevance })),
      archiveSize: all.length,
      memoryTokens,
      naiveTokens,
    };
  }

  async function assembleForPrompt(query: string): Promise<string> {
    const a = await memory.assemble(query);
    const pins = a.header.filter((f) => f.kind === 'pin').map((f) => `- ${f.text}`);
    const verified = a.header.filter((f) => f.kind === 'verified').map((f) => `- [${f.rubric} ${(f.confidence ?? 1).toFixed(2)}] ${f.text}`);
    const retrieved = a.retrieved.map((f) => `- ${f.text}`);
    return [
      '=== MEMORY (Triolima) ===',
      pins.length ? `Pinned facts:\n${pins.join('\n')}` : '',
      verified.length ? `Verified signals:\n${verified.join('\n')}` : '',
      retrieved.length ? `Relevant to this question:\n${retrieved.join('\n')}` : '',
      `(${a.archiveSize} facts in the deep archive — ask for one if you need it.)`,
    ].filter(Boolean).join('\n\n');
  }

  async function observeHop(role: 'user' | 'assistant' | 'tool', content: string, hop: 'input' | 'tool_call' | 'tool_result' | 'output', meta?: Record<string, unknown>): Promise<void> {
    naiveTokens += estimateTokens(content);
    memory.observe({ role, content, hop, ...(meta ? { meta } : {}) });
    await memory.consolidate();
  }

  async function say(userText: string): Promise<void> {
    try {
      await observeHop('user', userText, 'input');
      deps.emit({ kind: 'memory', snapshot: snapshot(userText) });

      const messages: ApiMessage[] = [{ role: 'user', content: userText }];
      let calls = 0;

      while (true) {
        if (calls >= maxCalls) {
          deps.emit({ kind: 'notice', text: `Reached the ${maxCalls}-call cost cap for this message.` });
          break;
        }
        const system = `${SYSTEM}\n\n${await assembleForPrompt(userText)}`;
        deps.emit({ kind: 'memory', snapshot: snapshot(userText) });

        const completion = await deps.provider.complete(system, messages, TOOL_SPECS);
        calls += 1;
        messages.push({ role: 'assistant', content: completion.raw });

        if (completion.text.trim()) {
          await observeHop('assistant', completion.text, 'output');
          deps.emit({ kind: 'assistant', text: completion.text });
          deps.emit({ kind: 'memory', snapshot: snapshot(userText) });
        }

        if (!completion.toolCalls.length) {
          deps.emit({ kind: 'done', usage: completion.usage });
          break;
        }

        const results: unknown[] = [];
        let paused = false;

        for (const call of completion.toolCalls) {
          const callText = `${call.name}(${JSON.stringify(call.input)})`;
          await observeHop('tool', callText, 'tool_call', { tool: call.name });
          deps.emit({ kind: 'tool_call', name: call.name, input: call.input });
          deps.emit({ kind: 'memory', snapshot: snapshot(userText) });

          let output: string;

          if (MUTATING.has(call.name)) {
            // A write to production. If memory flagged it (irreversible-action
            // rubric), use that card; otherwise raise one for the write itself.
            const card = memory.pending()[0] ?? synthCard(call, memory.turn());
            deps.emit({ kind: 'card', card });
            const ans = await deps.askHuman(card);
            memory.answer(card.print, ans.answer, ans.text);
            deps.emit({ kind: 'memory', snapshot: snapshot(userText) });

            if (ans.answer === 'pause') {
              output = 'Human paused the response. Do not apply any change; wait for instructions.';
              paused = true;
            } else if (ans.answer === 'correct') {
              output = `Not applied. Human correction: ${ans.text ?? '(none given)'}`;
            } else {
              output = executeTool(call.name, call.input);
            }
          } else {
            output = executeTool(call.name, call.input);
          }

          results.push(toolResultBlock(call.id, output));
          await observeHop('tool', output, 'tool_result', { tool: call.name, status: paused ? 'paused' : 'completed' });
          deps.emit({ kind: 'tool_result', name: call.name, output });
          deps.emit({ kind: 'memory', snapshot: snapshot(userText) });
        }

        messages.push({ role: 'user', content: results });

        if (paused) {
          deps.emit({ kind: 'done', usage: completion.usage });
          break;
        }
      }
    } catch (err) {
      deps.emit({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  return { memory, say };
}

/** A card for a write that memory did not independently flag. */
function synthCard(call: ToolCall, turn: number): Card {
  return {
    print: `write:${call.name}:${turn}`,
    rubric: 'irreversible action',
    says: `Apply to production: ${String(call.input['action'] ?? call.name)}`,
    confidence: 1,
    alert: 1,
    sourceTurn: turn,
    answers: ['keep_going', 'pause', 'correct'],
  };
}
