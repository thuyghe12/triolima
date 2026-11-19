/**
 * The proof. One long conversation, three strategies, measured the same way:
 * how many tokens each would send per turn, and whether the critical facts
 * planted at the start are still recalled at the end.
 *
 *   naive-full    the whole history every turn — perfect recall, unbounded cost
 *   naive-window  the last W turns — bounded cost, forgets the old facts
 *   triolima      three-tier memory — bounded cost AND recall
 *
 * Pure and deterministic, so both the printed benchmark and the CI test read
 * the same numbers from here.
 */
import type { Config, Turn } from '../src/types';
import { createMemory } from '../src/memory';
import { estimateTokens } from '../src/tokens';

export interface Scenario {
  turns: Turn[];
  probe: string;
  /** Substrings that must survive to the end for recall to count. */
  facts: string[];
}

/** A long incident conversation: critical facts at turn 1, then noise + filler. */
export function makeScenario(n = 120): Scenario {
  const turns: Turn[] = [
    {
      role: 'user',
      content:
        'Incident INC-7788 opened: checkout p95 at 4s, users cannot place orders. ' +
        'Root cause traced to connection pool exhaustion on pg-checkout.',
    },
  ];
  for (let i = 2; i <= n; i++) {
    if (i % 7 === 0) turns.push({ role: 'user', content: `Applied the fix for subsystem ${i}; checks pass. Resolved.` });
    else if (i % 3 === 0) turns.push({ role: 'user', content: 'ok thanks, got it' });
    else turns.push({ role: 'user', content: `Checking metric ${i} on service svc-${i % 5}; latency nominal, nothing unusual.` });
  }
  return { turns, probe: 'What is the incident id and the root cause?', facts: ['INC-7788', 'connection pool'] };
}

export interface Result {
  strategy: string;
  avgTokens: number;
  finalTokens: number;
  /** Share of critical facts present in the final context, 0–1. */
  recall: number;
}

const recallOf = (text: string, facts: string[]): number =>
  facts.filter((f) => text.toLowerCase().includes(f.toLowerCase())).length / facts.length;

export function benchConfig(): Config {
  return {
    pins: [/INC-\d+/],
    rubrics: [
      { name: 'root cause', cues: ['root cause', 'traced to'], threshold: 0.8 },
      { name: 'mitigation', cues: ['applied', 'fix', 'resolved'], threshold: 0.8 },
    ],
    budget: { hotFacts: 8, retrieveK: 4, halfLifeTurns: 6 },
  };
}

function naive(s: Scenario, window: number | null): Result {
  let sum = 0;
  let finalText = '';
  for (let i = 0; i < s.turns.length; i++) {
    const slice = window == null ? s.turns.slice(0, i + 1) : s.turns.slice(Math.max(0, i + 1 - window), i + 1);
    const text = slice.map((t) => t.content).join('\n');
    sum += estimateTokens(text);
    if (i === s.turns.length - 1) finalText = text;
  }
  return {
    strategy: window == null ? 'naive-full' : `naive-window(${window})`,
    avgTokens: Math.round(sum / s.turns.length),
    finalTokens: estimateTokens(finalText),
    recall: recallOf(finalText, s.facts),
  };
}

async function triolima(s: Scenario): Promise<Result> {
  const m = createMemory(benchConfig());
  let sum = 0;
  for (let i = 0; i < s.turns.length; i++) {
    m.observe(s.turns[i]!);
    if ((i + 1) % 7 === 0) await m.consolidate();
    const ctx = await m.assemble(s.probe);
    sum += ctx.tokens;
  }
  await m.consolidate();
  const ctx = await m.assemble(s.probe);
  const text = [...ctx.header, ...ctx.retrieved].map((f) => f.text).join(' | ');
  return {
    strategy: 'triolima',
    avgTokens: Math.round(sum / s.turns.length),
    finalTokens: ctx.tokens,
    recall: recallOf(text, s.facts),
  };
}

export async function measure(s = makeScenario()): Promise<Result[]> {
  return [naive(s, null), naive(s, 12), await triolima(s)];
}
