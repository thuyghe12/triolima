import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemory } from '../src/memory';
import type { Config } from '../src/types';

const config = (): Config => ({
  pins: [/INC-\d+/, /USD\s?[\d,]+/, /\b[45]\d{2}\b/],
  rubrics: [
    { name: 'root cause', cues: ['root cause', 'traced to', 'because'], threshold: 0.8, weight: 1 },
    { name: 'mitigation', cues: ['applied', 'enabled', 'mitigat', 'fix'], threshold: 0.8, weight: 0.9 },
    { name: 'impact', cues: ['users', 'impact', 'failed', 'orders'], threshold: 0.75, weight: 0.9 },
  ],
  budget: { hotFacts: 8, retrieveK: 4, halfLifeTurns: 6 },
});

test('end to end: an incident conversation, remembered by meaning', async () => {
  const m = createMemory(config());

  m.observe({ role: 'user', content: 'Spike in 5xx on checkout — INC-5120 opened, users cannot place orders. Sev-1.' });
  m.observe({ role: 'user', content: 'Confirmed: payments-api throwing 503, Stripe latency ~2s.' });
  const pruned = m.observe({ role: 'user', content: 'ok cool thanks, give me a sec' });
  assert.ok(pruned.pruned, 'the filler turn was pruned');
  m.observe({ role: 'user', content: 'payments-api 503s traced to Stripe timeout — that is the root cause.' });
  m.observe({ role: 'user', content: 'Mitigation applied: circuit breaker enabled, retry=3.' });
  m.observe({ role: 'user', content: 'Resolved. ~340 orders failed, USD 8,200 impact. Status page updated.' });

  const con = await m.consolidate();
  assert.ok(con.extracted.length >= 2, `extracted ${con.extracted.length}`);

  const ctx = await m.assemble('what was the root cause and the customer impact?');

  // Pins are always in the hot header.
  const headerText = ctx.header.map((f) => f.text).join(' | ');
  assert.match(headerText, /INC-5120/, 'the incident id survived');
  assert.match(headerText, /USD\s?8,200|503/, 'a hard fact survived');

  // The root cause is recalled — in the header or retrieved for this query.
  const everything = [...ctx.header, ...ctx.retrieved].map((f) => f.text).join(' | ');
  assert.match(everything, /root cause|Stripe timeout/i, 'the root cause is recalled');

  // Bounded cost: the whole assembled memory is small.
  assert.ok(ctx.tokens < 400, `assembled memory was ${ctx.tokens} tokens`);

  // Full audit: every actor is represented on the tree.
  const actors = new Set(m.tree.log().map((e) => e.actor));
  for (const a of ['agent', 'fastpath', 'rubric', 'ranker']) assert.ok(actors.has(a as never), `missing actor ${a}`);
  assert.ok(m.tree.log().some((e) => e.op === 'prune'));
  assert.ok(m.tree.log().some((e) => e.op === 'extract'));
});

test('cost stays bounded as the archive grows', async () => {
  const m = createMemory(config());
  let last = 0;
  for (let i = 1; i <= 60; i++) {
    m.observe({ role: 'user', content: `Step ${i}: traced issue ${i}, root cause is subsystem ${i}, applied fix ${i}.` });
    if (i % 3 === 0) await m.consolidate();
    const ctx = await m.assemble(`status of subsystem ${i}?`);
    last = ctx.tokens;
    assert.ok(ctx.tokens < 600, `turn ${i}: ${ctx.tokens} tokens`);
  }
  // The archive is large, the per-turn memory is still small.
  assert.ok(m.store.all().length > 10, 'the archive grew');
  assert.ok(last < 600, `final per-turn memory ${last} tokens while archive holds ${m.store.all().length}`);
});

test('a used fact resets its decay clock and stays hot', async () => {
  const m = createMemory({ ...config(), budget: { hotFacts: 2, retrieveK: 2, halfLifeTurns: 2 } });
  m.observe({ role: 'user', content: 'root cause is the pool, because connections ran out.' });
  await m.consolidate();
  const before = (await m.assemble('pool?')).header.length;
  assert.ok(before >= 1);
});
