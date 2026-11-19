/**
 * The agent — a real Claude Code agent, driven by the Claude Agent SDK, governed
 * by Triolima.
 *
 * We do NOT own the model loop here; the Agent SDK (the Claude Code harness) does.
 * Triolima plugs into it through the harness's own, on-device instrumentation:
 *
 *   UserPromptSubmit hook  observe the turn, run the watchdogs, and INJECT the
 *                          governed memory as additionalContext — this is how
 *                          Triolima feeds the agent without owning its context.
 *   PreToolUse / PostToolUse hooks  observe tool hops, run the watchdogs.
 *   canUseTool             the permission gate (keeps this a chat+recall agent).
 *   the message stream     real assistant text and real usage/cost/latency.
 *
 * Every hop is a real Claude Code lifecycle event (the same ones it exports over
 * OTLP), captured in-process — no fake spans. The watchdogs run on every turn.
 */
import { query, tool, createSdkMcpServer, type Options, type HookInput, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  createMemory, estimateTokens, hybridRetrieve,
  type Memory, type Card, type Answer, type MemoryEvent,
} from '../../src/index';
import { configFrom, WATCHERS, WATCHER_BY_RUBRIC, WATCHER_BY_ID, type Tier, type Watcher } from './config';

export type SpanKind = 'input' | 'watcher' | 'tool' | 'llm' | 'output';
export type SpanStatus = 'ok' | 'hit' | 'fire' | 'held' | 'ask' | 'skip';

export interface Span {
  id: string; turn: number; name: string; kind: SpanKind; tier?: Tier;
  startMs: number; durMs: number; status: SpanStatus; detail: string;
  attrs?: Record<string, string | number>;
}

export type AgentEvent =
  | { kind: 'span'; span: Span }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool_call'; name: string; input: unknown }
  | { kind: 'tool_result'; name: string; output: string }
  | { kind: 'stat'; turn: number; memoryTokens: number; naiveTokens: number; usageIn?: number; usageOut?: number; costUsd?: number; durMs?: number }
  | { kind: 'card'; card: Card }
  | { kind: 'notice'; text: string }
  | { kind: 'done' }
  | { kind: 'error'; message: string };

export type AskHuman = (card: Card) => Promise<{ answer: Answer; text?: string }>;
export type Judge = (text: string) => Promise<{ verdict: string; confidence: number } | null>;

export interface AgentDeps {
  emit: (e: AgentEvent) => void;
  askHuman: AskHuman;
  apiKey: string;
  model?: string;
  judge?: Judge;
  judgeCues?: string[];
  watchers?: Watcher[];
}

export interface Agent {
  readonly memory: Memory;
  ask: (text: string) => void;
  stop: () => void;
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const num = (v: unknown): string => (typeof v === 'number' ? v.toFixed(2) : String(v ?? ''));

/** Map a memory-tree commit to the watcher that produced it, and its status. */
function watcherOf(e: MemoryEvent): { id: string; status: SpanStatus; detail: string } | null {
  switch (e.op) {
    case 'pin': return { id: 'identifiers', status: 'fire', detail: `pinned ${String(e.data['value'] ?? '')}`.trim() };
    case 'prune': return { id: 'filler', status: 'fire', detail: 'pruned low-signal turn' };
    case 'fold': return { id: 'identifiers', status: 'fire', detail: `folded ${String(e.data['steps'] ?? '')} steps`.trim() };
    case 'extract': { const id = WATCHER_BY_RUBRIC[String(e.data['rubric'] ?? '')]; return id ? { id, status: 'fire', detail: `extracted · ${num(e.data['confidence'])}` } : null; }
    case 'hold': { const id = WATCHER_BY_RUBRIC[String(e.data['rubric'] ?? '')]; return id ? { id, status: 'held', detail: `held · ${num(e.data['confidence'])} < ${num(e.data['threshold'])}` } : null; }
    case 'alert': return { id: 'sensitive', status: 'ask', detail: 'raised a card' };
    case 'answer': return { id: 'sensitive', status: 'ask', detail: `you · ${String(e.data['answer'] ?? '')}` };
    default: return null;
  }
}

/** An async queue the agent reads user turns from (streaming input). */
function userStream() {
  const buf: { type: 'user'; message: { role: 'user'; content: string }; parent_tool_use_id: null }[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  async function* gen() {
    while (!done) {
      if (buf.length) { yield buf.shift()!; continue; }
      await new Promise<void>((r) => { wake = r; });
    }
  }
  return {
    gen: gen(),
    push: (text: string) => { buf.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }); wake?.(); wake = null; },
    end: () => { done = true; wake?.(); wake = null; },
  };
}

export function createAgent(deps: AgentDeps): Agent {
  const watchers = deps.watchers ?? WATCHERS;
  const memory = createMemory(configFrom(watchers));
  const judgeCues = deps.judgeCues ?? [];
  let naiveTokens = 0;
  let seq = 0;
  let traced = 0;
  let turn = 0;
  let t0 = now();

  const span = (name: string, kind: SpanKind, started: number, status: SpanStatus, detail: string, extra?: { tier?: Tier; attrs?: Record<string, string | number> }): void => {
    deps.emit({ kind: 'span', span: { id: `s${seq++}`, turn, name, kind, startMs: Math.max(0, started - t0), durMs: Math.max(0, now() - started), status, detail, ...(extra?.tier ? { tier: extra.tier } : {}), ...(extra?.attrs ? { attrs: extra.attrs } : {}) } });
  };

  function flushWatchers(started: number): void {
    const log = memory.tree.log();
    for (let i = traced; i < log.length; i++) {
      const w = watcherOf(log[i]!);
      if (!w) continue;
      const watcher = WATCHER_BY_ID[w.id];
      span(`watcher:${w.id}`, 'watcher', started, w.status, `${watcher?.name ?? w.id} — ${w.detail}`, watcher ? { tier: watcher.tier } : {});
    }
    traced = log.length;
  }

  async function consolidateAndTrace(started: number): Promise<void> {
    await memory.consolidate();
    flushWatchers(started);
  }

  function assembleBlock(query: string): { text: string; tokens: number } {
    const a = memory.store.all();
    const header = a.filter((f) => f.kind === 'pin').slice(0, 8).map((f) => `- ${f.text}`);
    const verified = memory.store.verified().slice(0, 8).map((f) => `- [${f.rubric} ${(f.confidence ?? 1).toFixed(2)}] ${f.text}`);
    const hits = hybridRetrieve(query, a, 4).map((f) => `- ${f.text}`);
    const tokens = [...header, ...verified, ...hits].reduce((t, s) => t + estimateTokens(s), 0) + 40;
    const text = [
      '=== MEMORY (maintained by Triolima) ===',
      header.length ? `Facts:\n${header.join('\n')}` : '',
      verified.length ? `Known:\n${verified.join('\n')}` : '',
      hits.length ? `Possibly relevant:\n${hits.join('\n')}` : '',
      a.length ? `(${a.length} items in memory — call recall to search them.)` : '',
    ].filter(Boolean).join('\n\n');
    return { text, tokens };
  }

  function runRecall(q: string): string {
    const hits = hybridRetrieve(q, memory.store.all(), 5);
    return hits.length ? hits.map((f) => `- ${f.text}`).join('\n') : 'No earlier matches in memory.';
  }

  async function clearCards(started: number): Promise<boolean> {
    for (const card of memory.pending()) {
      deps.emit({ kind: 'card', card });
      const ans = await deps.askHuman(card);
      memory.answer(card.print, ans.answer, ans.text);
      flushWatchers(started);
      if (ans.answer === 'pause') { deps.emit({ kind: 'notice', text: 'Paused by you.' }); return false; }
      if (ans.answer === 'correct' && ans.text) deps.emit({ kind: 'notice', text: `Noted: ${ans.text}` });
    }
    return true;
  }

  // The recall tool — searches the agent's own Triolima memory.
  const recall = tool('recall', 'Search your own persistent memory for earlier things the person said that are not already in the MEMORY context.', { query: z.string().describe('what to look for') },
    (args) => Promise.resolve({ content: [{ type: 'text' as const, text: runRecall(args.query) }] }));

  const stream = userStream();

  const hooks: Options['hooks'] = {
    UserPromptSubmit: [{ hooks: [async (input: HookInput) => {
      if (input.hook_event_name !== 'UserPromptSubmit') return {};
      turn += 1; t0 = now(); traced = memory.tree.log().length;
      const started = now();
      naiveTokens += estimateTokens(input.prompt);
      memory.observe({ role: 'user', content: input.prompt, hop: 'input' });
      span('input', 'input', started, 'ok', input.prompt.slice(0, 80), { attrs: { tokens: estimateTokens(input.prompt) } });
      await consolidateAndTrace(started);

      // Tone (llm watcher) runs in parallel, only on a loaded turn.
      const tone = deps.judge && judgeCues.some((c) => input.prompt.toLowerCase().includes(c)) ? deps.judge(input.prompt) : null;

      // Human tier: a sensitive-action card pauses the turn before the model runs.
      if (!(await clearCards(started))) {
        return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit' as const, additionalContext: 'The user paused this turn. Acknowledge and wait; do not act.' } };
      }

      const mem = assembleBlock(input.prompt);
      deps.emit({ kind: 'stat', turn, memoryTokens: mem.tokens, naiveTokens });

      if (tone) { try { const v = await tone; if (v) span('watcher:tone', 'watcher', started, 'fire', `Tone — ${v.verdict} · ${v.confidence.toFixed(2)}`, { tier: 'llm' }); } catch { /* non-fatal */ } }

      return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit' as const, additionalContext: mem.text } };
    }] }],

    PreToolUse: [{ hooks: [async (input: HookInput) => {
      if (input.hook_event_name !== 'PreToolUse') return {};
      const started = now();
      const call = `${input.tool_name}(${JSON.stringify(input.tool_input)})`;
      deps.emit({ kind: 'tool_call', name: input.tool_name, input: input.tool_input });
      naiveTokens += estimateTokens(call);
      memory.observe({ role: 'tool', content: call, hop: 'tool_call', meta: { tool: input.tool_name } });
      span(`tool:${input.tool_name}`, 'tool', started, 'ok', call.slice(0, 80));
      await consolidateAndTrace(started);
      return {};
    }] }],

    PostToolUse: [{ hooks: [async (input: HookInput) => {
      if (input.hook_event_name !== 'PostToolUse') return {};
      const started = now();
      const out = typeof input.tool_response === 'string' ? input.tool_response : JSON.stringify(input.tool_response);
      deps.emit({ kind: 'tool_result', name: input.tool_name, output: out.slice(0, 400) });
      naiveTokens += estimateTokens(out);
      memory.observe({ role: 'tool', content: out, hop: 'tool_result', meta: { tool: input.tool_name, status: 'completed' } });
      span(`tool:${input.tool_name}:result`, 'tool', started, 'ok', out.slice(0, 80));
      await consolidateAndTrace(started);
      return {};
    }] }],
  };

  const canUseTool = (toolName: string): Promise<PermissionResult> =>
    Promise.resolve(toolName === 'mcp__triolima__recall'
      ? { behavior: 'allow', updatedInput: {} }
      : { behavior: 'deny', message: 'This agent is a memory demo and only has the recall tool.' });

  const options: Options = {
    model: deps.model ?? 'haiku',
    systemPrompt: 'You are a helpful, concise assistant with persistent memory. The MEMORY block in your context is maintained for you by Triolima from the whole conversation — rely on it instead of asking the person to repeat themselves. Call the recall tool to search older memory. Keep replies natural and brief.',
    settingSources: [],
    permissionMode: 'default',
    mcpServers: { triolima: createSdkMcpServer({ name: 'triolima', tools: [recall] }) },
    hooks,
    canUseTool,
    env: { ...process.env, ANTHROPIC_API_KEY: deps.apiKey },
  };

  const q = query({ prompt: stream.gen, options });

  // Consume the message stream: real assistant text + real usage/cost.
  (async () => {
    try {
      for await (const msg of q) {
        if (msg.type === 'assistant') {
          const blocks = Array.isArray(msg.message.content) ? msg.message.content : [];
          const text = blocks
            .filter((b) => (b as { type?: string }).type === 'text')
            .map((b) => (b as { text?: string }).text ?? '')
            .join('');
          if (text.trim()) {
            const started = now();
            deps.emit({ kind: 'assistant', text });
            naiveTokens += estimateTokens(text);
            memory.observe({ role: 'assistant', content: text, hop: 'output' });
            span('output', 'output', started, 'ok', text.slice(0, 80), { attrs: { tokens: estimateTokens(text) } });
            await consolidateAndTrace(started);
          }
        } else if (msg.type === 'result') {
          const mem = assembleBlock('');
          const usage = (msg as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
          const apiMs = (msg as { duration_api_ms?: number }).duration_api_ms;
          if (typeof apiMs === 'number' && apiMs > 0) {
            span('model.response', 'llm', now() - apiMs, 'ok', `${deps.model ?? 'haiku'} · ${usage?.input_tokens ?? 0}→${usage?.output_tokens ?? 0} tok`, { attrs: { in: usage?.input_tokens ?? 0, out: usage?.output_tokens ?? 0 } });
          }
          deps.emit({
            kind: 'stat', turn, memoryTokens: mem.tokens, naiveTokens,
            ...(usage?.input_tokens != null ? { usageIn: usage.input_tokens } : {}),
            ...(usage?.output_tokens != null ? { usageOut: usage.output_tokens } : {}),
            ...(typeof (msg as { total_cost_usd?: number }).total_cost_usd === 'number' ? { costUsd: (msg as { total_cost_usd: number }).total_cost_usd } : {}),
            ...(typeof (msg as { duration_ms?: number }).duration_ms === 'number' ? { durMs: (msg as { duration_ms: number }).duration_ms } : {}),
          });
          deps.emit({ kind: 'done' });
        }
      }
    } catch (err) {
      deps.emit({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  })();

  return { memory, ask: (text) => stream.push(text), stop: () => stream.end() };
}
