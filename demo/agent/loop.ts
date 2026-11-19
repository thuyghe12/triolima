/**
 * The agent loop — where Triolima meets a real model, and where every hop is
 * classified by the mechanism that handled it.
 *
 * We own the loop, so we instrument it directly: each hop (input, tool_call,
 * tool_result, output) is `observe`d, Tier 2 runs, and the prompt the model sees
 * is whatever `assemble` discloses — not the transcript. As operations land on
 * the audit tree, the loop maps each to its tier (code · decision · llm · human)
 * and emits a trace row, so the right panel shows, live, which mechanism made
 * each call and when. The one subjective call (blast radius) escalates to a
 * narrow LLM via an injected `judge`; everything else is deterministic code, a
 * scored decision, or a human card.
 */
import {
  createMemory, estimateTokens,
  type Memory, type Card, type Answer, type MemoryEvent,
} from '../../src/index';
import type { ModelProvider, ApiMessage, ToolCall } from './provider';
import { MEMORY_CONFIG, SYSTEM, TIER_BY_ITEM, type Tier } from './config';
import { TOOL_SPECS, MUTATING, executeTool } from './tools';

export interface TraceRow {
  at: number;
  hop: string;
  tier: Tier;
  item: string;
  verdict: string;
}

export type LoopEvent =
  | { kind: 'hop'; hop: string; at: number }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool_call'; name: string; input: Record<string, unknown> }
  | { kind: 'tool_result'; name: string; output: string }
  | { kind: 'trace'; row: TraceRow }
  | { kind: 'stat'; turn: number; memoryTokens: number; naiveTokens: number }
  | { kind: 'card'; card: Card }
  | { kind: 'notice'; text: string }
  | { kind: 'done'; usage: { input: number; output: number } }
  | { kind: 'error'; message: string };

export type AskHuman = (card: Card) => Promise<{ answer: Answer; text?: string }>;
/** The narrow-LLM tier: a subjective judgment, injected so tests stay deterministic. */
export type Judge = (text: string) => Promise<{ verdict: string; confidence: number } | null>;

export interface SessionDeps {
  provider: ModelProvider;
  emit: (e: LoopEvent) => void;
  askHuman: AskHuman;
  judge?: Judge;
  judgeCues?: string[];
  maxModelCalls?: number;
}

export interface Session {
  readonly memory: Memory;
  say: (userText: string) => Promise<void>;
}

const num = (v: unknown): string => (typeof v === 'number' ? v.toFixed(2) : String(v ?? ''));

/** Map an audit-tree commit to its mechanism tier and a one-line verdict. */
function classify(e: MemoryEvent): { item: string; tier: Tier; verdict: string } | null {
  switch (e.op) {
    case 'pin': return { item: 'Hard facts', tier: 'code', verdict: `pinned ${String(e.data['value'] ?? '')}`.trim() };
    case 'prune': return { item: 'Filler pruning', tier: 'code', verdict: 'pruned low-signal turn' };
    case 'fold': return { item: 'Task folding', tier: 'code', verdict: `folded ${String(e.data['steps'] ?? '')} steps`.trim() };
    case 'extract': {
      const r = String(e.data['rubric'] ?? '');
      return { item: r, tier: TIER_BY_ITEM[r] ?? 'decision', verdict: `extracted · ${num(e.data['confidence'])}` };
    }
    case 'hold': {
      const r = String(e.data['rubric'] ?? '');
      return { item: r, tier: TIER_BY_ITEM[r] ?? 'decision', verdict: `held · ${num(e.data['confidence'])} < ${num(e.data['threshold'])}` };
    }
    case 'alert': return { item: 'Irreversible action', tier: 'human', verdict: 'routed to a human' };
    case 'answer': return { item: 'Irreversible action', tier: 'human', verdict: `human · ${String(e.data['answer'] ?? '')}` };
    default: return null; // 'turn', 'assemble' — not a classified decision
  }
}

export function createSession(deps: SessionDeps): Session {
  const memory = createMemory(MEMORY_CONFIG);
  const maxCalls = deps.maxModelCalls ?? 8;
  const judgeCues = deps.judgeCues ?? [];
  let naiveTokens = 0;
  let tracedUpTo = 0;
  let judgedThisTurn = false;

  function flushTrace(hop: string): void {
    const log = memory.tree.log();
    for (let i = tracedUpTo; i < log.length; i++) {
      const e = log[i]!;
      const c = classify(e);
      if (c) deps.emit({ kind: 'trace', row: { at: e.at, hop, tier: c.tier, item: c.item, verdict: c.verdict } });
    }
    tracedUpTo = log.length;
  }

  async function observeHop(role: 'user' | 'assistant' | 'tool', content: string, hop: string, meta?: Record<string, unknown>): Promise<void> {
    naiveTokens += estimateTokens(content);
    deps.emit({ kind: 'hop', hop, at: memory.turn() + 1 });
    memory.observe({ role, content, hop: hop as 'input' | 'tool_call' | 'tool_result' | 'output', ...(meta ? { meta } : {}) });
    await memory.consolidate();
    flushTrace(hop);

    // The narrow-LLM tier: a subjective severity call, only on an output hop that
    // looks severity-relevant, at most once per message, and never fatal.
    if (deps.judge && role === 'assistant' && !judgedThisTurn && judgeCues.some((c) => content.toLowerCase().includes(c))) {
      judgedThisTurn = true;
      try {
        const v = await deps.judge(content);
        if (v) deps.emit({ kind: 'trace', row: { at: memory.turn(), hop, tier: 'llm', item: 'Blast radius', verdict: `${v.verdict} · ${v.confidence.toFixed(2)}` } });
      } catch {
        deps.emit({ kind: 'trace', row: { at: memory.turn(), hop, tier: 'llm', item: 'Blast radius', verdict: 'judge unavailable — kept cheaper tiers' } });
      }
    }
  }

  async function assembleForPrompt(query: string): Promise<string> {
    const a = await memory.assemble(query);
    tracedUpTo = memory.tree.log().length; // the ranker commit is not a classified decision
    deps.emit({ kind: 'stat', turn: memory.turn(), memoryTokens: a.tokens, naiveTokens });
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

  async function say(userText: string): Promise<void> {
    judgedThisTurn = false;
    try {
      await observeHop('user', userText, 'input');

      const messages: ApiMessage[] = [{ role: 'user', content: userText }];
      let calls = 0;

      while (true) {
        if (calls >= maxCalls) {
          deps.emit({ kind: 'notice', text: `Reached the ${maxCalls}-call cost cap for this message.` });
          break;
        }
        const system = `${SYSTEM}\n\n${await assembleForPrompt(userText)}`;
        const completion = await deps.provider.complete(system, messages, TOOL_SPECS);
        calls += 1;
        messages.push({ role: 'assistant', content: completion.raw });

        if (completion.text.trim()) {
          deps.emit({ kind: 'assistant', text: completion.text });
          await observeHop('assistant', completion.text, 'output');
        }

        if (!completion.toolCalls.length) {
          deps.emit({ kind: 'done', usage: completion.usage });
          break;
        }

        const results: unknown[] = [];
        let paused = false;

        for (const call of completion.toolCalls) {
          const callText = `${call.name}(${JSON.stringify(call.input)})`;
          deps.emit({ kind: 'tool_call', name: call.name, input: call.input });
          await observeHop('tool', callText, 'tool_call', { tool: call.name });

          let output: string;
          if (MUTATING.has(call.name)) {
            const card = memory.pending()[0] ?? synthCard(call, memory.turn());
            deps.emit({ kind: 'card', card });
            const ans = await deps.askHuman(card);
            memory.answer(card.print, ans.answer, ans.text);
            flushTrace('tool_call');
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

          results.push({ type: 'tool_result', tool_use_id: call.id, content: output });
          deps.emit({ kind: 'tool_result', name: call.name, output });
          await observeHop('tool', output, 'tool_result', { tool: call.name, status: paused ? 'paused' : 'completed' });
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

function synthCard(call: ToolCall, turn: number): Card {
  return {
    print: `write:${call.name}:${turn}`,
    rubric: 'Irreversible action',
    says: `Apply to production: ${String(call.input['action'] ?? call.name)}`,
    confidence: 1,
    alert: 1,
    sourceTurn: turn,
    answers: ['keep_going', 'pause', 'correct'],
  };
}
