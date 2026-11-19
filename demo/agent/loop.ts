/**
 * The agent loop — a real, user-led conversation, instrumented per hop.
 *
 * No scenario and no scripted corpus: the person talks, a real model answers, and
 * Triolima governs the memory. We own the loop, so we emit a true per-hop trace —
 * OTel-style spans with real durations and attributes: input → each watcher that
 * acts → consolidate → assemble → llm.request (real tokens + latency) → recall
 * (if the model calls it) → output. A sensitive-action watcher can raise a card
 * mid-turn and pause for the person. The model sits behind a one-method provider,
 * so the loop is tested with a scripted model and runs for real with a key.
 */
import {
  createMemory, estimateTokens, hybridRetrieve,
  type Memory, type Card, type Answer, type MemoryEvent, type Store, type Tree,
} from '../../src/index';
import type { ModelProvider, ApiMessage } from './provider';
import { configFrom, WATCHERS, SYSTEM, WATCHER_BY_RUBRIC, WATCHER_BY_ID, type Tier, type Watcher } from './config';
import { TOOL_SPECS } from './tools';

export type SpanKind = 'input' | 'watcher' | 'memory' | 'llm' | 'tool' | 'output';
export type SpanStatus = 'ok' | 'hit' | 'fire' | 'held' | 'ask' | 'skip';

export interface Span {
  id: string;
  turn: number;
  name: string;
  kind: SpanKind;
  tier?: Tier;
  startMs: number;
  durMs: number;
  status: SpanStatus;
  detail: string;
  attrs?: Record<string, string | number>;
}

export type LoopEvent =
  | { kind: 'span'; span: Span }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool_call'; name: string; input: Record<string, unknown> }
  | { kind: 'tool_result'; name: string; output: string }
  | { kind: 'stat'; turn: number; memoryTokens: number; naiveTokens: number }
  | { kind: 'card'; card: Card }
  | { kind: 'notice'; text: string }
  | { kind: 'done'; usage: { input: number; output: number } }
  | { kind: 'error'; message: string };

export type AskHuman = (card: Card) => Promise<{ answer: Answer; text?: string }>;
export type Judge = (text: string) => Promise<{ verdict: string; confidence: number } | null>;

export interface SessionDeps {
  provider: ModelProvider;
  emit: (e: LoopEvent) => void;
  askHuman: AskHuman;
  judge?: Judge;
  judgeCues?: string[];
  maxModelCalls?: number;
  /** The (editable) rubric; defaults to the built-in watchers. */
  watchers?: Watcher[];
  /** Reuse an existing store/tree so memory persists across a rubric change. */
  store?: Store;
  tree?: Tree;
}

export interface Session {
  readonly memory: Memory;
  say: (userText: string) => Promise<void>;
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Map a memory-tree commit to the watcher that produced it, and its status. */
function watcherOf(e: MemoryEvent): { id: string; status: SpanStatus; detail: string } | null {
  const num = (v: unknown) => (typeof v === 'number' ? v.toFixed(2) : String(v ?? ''));
  switch (e.op) {
    case 'pin': return { id: 'identifiers', status: 'fire', detail: `pinned ${String(e.data['value'] ?? '')}`.trim() };
    case 'prune': return { id: 'filler', status: 'fire', detail: 'pruned low-signal turn' };
    case 'fold': return { id: 'identifiers', status: 'fire', detail: `folded ${String(e.data['steps'] ?? '')} steps`.trim() };
    case 'extract': { const id = WATCHER_BY_RUBRIC[String(e.data['rubric'] ?? '')]; return id ? { id, status: 'fire', detail: `extracted · ${num(e.data['confidence'])}` } : null; }
    case 'hold': { const id = WATCHER_BY_RUBRIC[String(e.data['rubric'] ?? '')]; return id ? { id, status: 'held', detail: `held · ${num(e.data['confidence'])} < ${num(e.data['threshold'])}` } : null; }
    case 'alert': return { id: 'sensitive', status: 'ask', detail: 'raised a card' };
    case 'answer': return { id: 'sensitive', status: 'ask', detail: `you · ${String(e.data['answer'] ?? '')}` };
    default: return null; // 'turn', 'assemble' are structural, handled elsewhere
  }
}

export function createSession(deps: SessionDeps): Session {
  const memory = createMemory(configFrom(deps.watchers ?? WATCHERS), {
    ...(deps.store ? { store: deps.store } : {}),
    ...(deps.tree ? { tree: deps.tree } : {}),
  });
  const maxCalls = deps.maxModelCalls ?? 8;
  const judgeCues = deps.judgeCues ?? [];
  let naiveTokens = 0;
  let seq = 0;
  let traced = 0;
  let t0 = 0;

  const span = (turn: number, name: string, kind: SpanKind, started: number, status: SpanStatus, detail: string, extra?: { tier?: Tier; attrs?: Record<string, string | number> }): void => {
    deps.emit({ kind: 'span', span: { id: `s${seq++}`, turn, name, kind, startMs: Math.max(0, started - t0), durMs: Math.max(0, now() - started), status, detail, ...(extra?.tier ? { tier: extra.tier } : {}), ...(extra?.attrs ? { attrs: extra.attrs } : {}) } });
  };

  /** Emit a watcher span for every tree commit since the last flush. */
  function flushWatchers(turn: number, hopStart: number): void {
    const log = memory.tree.log();
    for (let i = traced; i < log.length; i++) {
      const e = log[i]!;
      const w = watcherOf(e);
      if (!w) continue;
      const watcher = WATCHER_BY_ID[w.id];
      span(turn, `watcher:${w.id}`, 'watcher', hopStart, w.status, `${watcher?.name ?? w.id} — ${w.detail}`, watcher ? { tier: watcher.tier } : {});
    }
    traced = log.length;
  }

  async function observeHop(turn: number, role: 'user' | 'assistant' | 'tool', content: string, hop: 'input' | 'tool_call' | 'tool_result' | 'output', label: string, kind: SpanKind, meta?: Record<string, unknown>): Promise<void> {
    const started = now();
    naiveTokens += estimateTokens(content);
    memory.observe({ role, content, hop, ...(meta ? { meta } : {}) });
    await memory.consolidate();
    span(turn, label, kind, started, 'ok', content.length > 80 ? content.slice(0, 80) + '…' : content, { attrs: { tokens: estimateTokens(content) } });
    flushWatchers(turn, started);

    // The narrow-LLM tier: a tone read, only on a loaded user turn, never fatal.
    if (deps.judge && role === 'user' && judgeCues.some((c) => content.toLowerCase().includes(c))) {
      const jStart = now();
      try {
        const v = await deps.judge(content);
        if (v) span(turn, 'watcher:tone', 'watcher', jStart, 'fire', `Tone — ${v.verdict} · ${v.confidence.toFixed(2)}`, { tier: 'llm', attrs: { verdict: v.verdict, confidence: v.confidence } });
      } catch {
        span(turn, 'watcher:tone', 'watcher', jStart, 'skip', 'Tone — judge unavailable', { tier: 'llm' });
      }
    }
  }

  /** The human tier: if a watcher raised a card, pause and ask. Returns false to stop the turn. */
  async function clearCards(turn: number): Promise<boolean> {
    for (const card of memory.pending()) {
      const started = now();
      deps.emit({ kind: 'card', card });
      const ans = await deps.askHuman(card);
      memory.answer(card.print, ans.answer, ans.text);
      flushWatchers(turn, started);
      if (ans.answer === 'pause') {
        deps.emit({ kind: 'notice', text: 'Paused by you. The agent is holding.' });
        return false;
      }
      if (ans.answer === 'correct' && ans.text) deps.emit({ kind: 'notice', text: `Noted: ${ans.text}` });
    }
    return true;
  }

  async function assembleForPrompt(turn: number, query: string): Promise<string> {
    const started = now();
    const a = await memory.assemble(query);
    traced = memory.tree.log().length; // the ranker commit is structural, not a watcher
    span(turn, 'memory.assemble', 'memory', started, 'ok', `${a.header.length} hot · ${a.retrieved.length} recalled · ${a.archiveSize} archived`, { attrs: { tokens: a.tokens, archive: a.archiveSize } });
    deps.emit({ kind: 'stat', turn, memoryTokens: a.tokens, naiveTokens });
    const pins = a.header.filter((f) => f.kind === 'pin').map((f) => `- ${f.text}`);
    const verified = a.header.filter((f) => f.kind === 'verified').map((f) => `- [${f.rubric} ${(f.confidence ?? 1).toFixed(2)}] ${f.text}`);
    const retrieved = a.retrieved.map((f) => `- ${f.text}`);
    return [
      '=== MEMORY (Triolima) ===',
      pins.length ? `Facts:\n${pins.join('\n')}` : '',
      verified.length ? `Known:\n${verified.join('\n')}` : '',
      retrieved.length ? `Possibly relevant:\n${retrieved.join('\n')}` : '',
      a.archiveSize ? `(${a.archiveSize} items in memory — call recall to search them.)` : '',
    ].filter(Boolean).join('\n\n');
  }

  function runRecall(query: string): string {
    const hits = hybridRetrieve(query, memory.store.all(), 5);
    if (!hits.length) return 'No earlier matches in memory.';
    return hits.map((f) => `- ${f.text}`).join('\n');
  }

  async function say(userText: string): Promise<void> {
    t0 = now();
    const turn = memory.turn() + 1;
    try {
      await observeHop(turn, 'user', userText, 'input', 'input', 'input');
      if (!(await clearCards(turn))) { deps.emit({ kind: 'done', usage: { input: 0, output: 0 } }); return; }

      const messages: ApiMessage[] = [{ role: 'user', content: userText }];
      let calls = 0;

      while (true) {
        if (calls >= maxCalls) { deps.emit({ kind: 'notice', text: `Reached the ${maxCalls}-call cap for this message.` }); break; }

        const system = `${SYSTEM}\n\n${await assembleForPrompt(turn, userText)}`;
        const started = now();
        const completion = await deps.provider.complete(system, messages, TOOL_SPECS);
        calls += 1;
        span(turn, 'llm.request', 'llm', started, 'ok', `${deps.provider.name} · ${completion.stopReason}`, { attrs: { model: deps.provider.name, in: completion.usage.input, out: completion.usage.output } });
        messages.push({ role: 'assistant', content: completion.raw });

        if (completion.text.trim()) {
          deps.emit({ kind: 'assistant', text: completion.text });
          await observeHop(turn, 'assistant', completion.text, 'output', 'output', 'output');
        }

        if (!completion.toolCalls.length) { deps.emit({ kind: 'done', usage: completion.usage }); break; }

        const results: unknown[] = [];
        for (const call of completion.toolCalls) {
          deps.emit({ kind: 'tool_call', name: call.name, input: call.input });
          await observeHop(turn, 'tool', `${call.name}(${JSON.stringify(call.input)})`, 'tool_call', `tool:${call.name}`, 'tool', { tool: call.name });
          const output = call.name === 'recall' ? runRecall(String(call.input['query'] ?? '')) : `Unknown tool ${call.name}`;
          results.push({ type: 'tool_result', tool_use_id: call.id, content: output });
          deps.emit({ kind: 'tool_result', name: call.name, output });
          await observeHop(turn, 'tool', output, 'tool_result', `tool:${call.name}:result`, 'tool', { tool: call.name, status: 'completed' });
        }
        messages.push({ role: 'user', content: results });
        if (!(await clearCards(turn))) { deps.emit({ kind: 'done', usage: completion.usage }); break; }
      }
    } catch (err) {
      deps.emit({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  return { memory, say };
}
