/**
 * The demo's agent loop, exercised end-to-end with a scripted model — so CI
 * proves the wiring (every hop observed, memory driving the prompt, the HITL
 * pause stopping a write) with no key and no network. The demo itself always
 * runs a real model; this only guards the plumbing around it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, type LoopEvent } from '../demo/agent/loop';
import { scripted } from '../demo/agent/provider';

test('the loop instruments every hop, and memory drives a bounded prompt', async () => {
  const events: LoopEvent[] = [];
  const provider = scripted([
    { text: 'Looking into INC-7788.', toolCalls: [{ id: 't1', name: 'get_incident', input: { id: 'INC-7788' } }] },
    { text: 'The connection pool is exhausted, traced to Stripe latency. Proposing a fix.', toolCalls: [{ id: 't2', name: 'apply_mitigation', input: { action: 'restart payments-api, raise pool to 400, enable circuit breaker' } }] },
    { text: 'INC-7788 mitigated.' },
  ]);
  const session = createSession({ provider, emit: (e) => events.push(e), askHuman: () => Promise.resolve({ answer: 'keep_going' }) });

  await session.say('Investigate INC-7788 on payments-api.');

  // Tier 1 pinned the hard facts verbatim.
  assert.ok(session.memory.store.pins().some((p) => p.text === 'INC-7788'));
  assert.ok(session.memory.store.pins().some((p) => /payments-api/i.test(p.text)));

  // All five actors acted on the one tree.
  const actors = new Set(session.memory.tree.log().map((e) => e.actor));
  for (const a of ['agent', 'fastpath', 'rubric', 'ranker', 'human'] as const) {
    assert.ok(actors.has(a), `expected actor ${a} on the tree`);
  }

  // Both hops surfaced as events, and the write ran after approval.
  assert.ok(events.some((e) => e.kind === 'tool_call' && e.name === 'apply_mitigation'));
  assert.ok(events.some((e) => e.kind === 'tool_result' && e.output.startsWith('Applied:')));

  // Trace rows are classified by mechanism tier, and the deterministic tiers fire.
  const trace = events.filter((e): e is Extract<LoopEvent, { kind: 'trace' }> => e.kind === 'trace');
  assert.ok(trace.some((t) => t.row.tier === 'code'), 'a code-tier decision was traced');
  assert.ok(trace.some((t) => t.row.tier === 'human'), 'a human-tier decision was traced');

  // The stat meter is driven live, and the prompt stays bounded regardless of how
  // much the full history grows. (The size win over naive history at scale is
  // asserted separately, over 120 turns, in bench.test.ts.)
  const stats = events.filter((e): e is Extract<LoopEvent, { kind: 'stat' }> => e.kind === 'stat');
  const last = stats[stats.length - 1];
  assert.ok(last, 'at least one stat');
  assert.ok(last.naiveTokens > 0, 'full-history baseline is tracked');
  assert.ok(last.memoryTokens < 500, 'disclosed prompt stays bounded');
});

test('a human pause stops the write before it runs', async () => {
  const events: LoopEvent[] = [];
  const provider = scripted([
    { toolCalls: [{ id: 't1', name: 'apply_mitigation', input: { action: 'restart payments-api' } }] },
    { text: 'Holding off until you say otherwise.' },
  ]);
  const session = createSession({ provider, emit: (e) => events.push(e), askHuman: () => Promise.resolve({ answer: 'pause' }) });

  await session.say('Fix INC-7788 now.');

  // The mitigation never executed.
  assert.ok(!events.some((e) => e.kind === 'tool_result' && e.output.startsWith('Applied:')));
  // The human's answer is on the audit tree.
  assert.ok(session.memory.tree.byActor('human').length >= 1);
  // A card was surfaced for the write.
  assert.ok(events.some((e) => e.kind === 'card'));
});

test('a correction blocks the write and feeds the agent back a note', async () => {
  const events: LoopEvent[] = [];
  const provider = scripted([
    { toolCalls: [{ id: 't1', name: 'apply_mitigation', input: { action: 'delete the connection pool' } }] },
    { text: 'Understood — using the circuit breaker instead.' },
  ]);
  const session = createSession({ provider, emit: (e) => events.push(e), askHuman: () => Promise.resolve({ answer: 'correct', text: 'raise the pool, do not delete it' }) });

  await session.say('Resolve INC-7788.');

  const result = events.find((e) => e.kind === 'tool_result');
  assert.ok(result && result.kind === 'tool_result' && /Human correction/.test(result.output));
  assert.ok(!events.some((e) => e.kind === 'tool_result' && e.output.startsWith('Applied:')));
});
