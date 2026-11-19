import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entropy, isLowSignal, findPins, isTaskBoundary, foldReceipt, runTier1, SIGNAL_FLOOR } from '../src/tier1';
import { createTree } from '../src/tree';

test('entropy: filler scores low, dense turns score high', () => {
  const filler = 'Ok cool, thanks — give me a sec to pull it up.';
  const dense = 'Confirmed: payments-api is throwing 503 to checkout, Stripe latency 2s on INC-5120.';
  assert.ok(isLowSignal(filler), `filler scored ${entropy(filler).toFixed(2)}`);
  assert.ok(!isLowSignal(dense), `dense scored ${entropy(dense).toFixed(2)}`);
  assert.ok(entropy(dense) > entropy(filler));
  assert.ok(entropy('') === 0);
});

test('findPins: hard facts matched verbatim, de-duped', () => {
  const pins = [/INC-\d+/, /USD\s?[\d,]+/, /\b[45]\d{2}\b/];
  const hits = findPins('INC-5120 hit a 503; impact USD 8,200. Still INC-5120.', pins);
  const values = hits.map((h) => h.value);
  assert.deepEqual(new Set(values), new Set(['INC-5120', '503', 'USD 8,200']));
  assert.equal(values.filter((v) => v === 'INC-5120').length, 1, 'de-duped');
});

test('task boundary: tool status or a close phrase', () => {
  assert.ok(isTaskBoundary({ role: 'tool', content: '', meta: { status: 'completed' } }));
  assert.ok(isTaskBoundary({ role: 'user', content: 'Mitigation applied, 5xx dropping.' }));
  assert.ok(!isTaskBoundary({ role: 'user', content: 'What does the runbook say?' }));
});

test('foldReceipt collapses a slice to one line', () => {
  const r = foldReceipt([
    { role: 'user', content: 'check payments-api' },
    { role: 'assistant', content: 'checking' },
    { role: 'user', content: 'Mitigation applied, breaker enabled, retry=3.' },
  ]);
  assert.match(r, /^Completed \(3 steps\): /);
  assert.match(r, /breaker enabled/);
});

test('runTier1 commits pins and records a prune', () => {
  const tree = createTree();
  runTier1({ role: 'user', content: 'INC-5120 opened, checkout 503s.' }, [/INC-\d+/, /\b[45]\d{2}\b/], tree, 1);
  runTier1({ role: 'user', content: 'ok thanks' }, [/INC-\d+/], tree, 2);
  const ops = tree.log().map((e) => e.op);
  assert.ok(ops.includes('pin'));
  assert.ok(ops.includes('prune'));
  assert.equal(tree.byActor('fastpath').length, tree.log().length);
});

test('SIGNAL_FLOOR is the documented default', () => {
  assert.equal(SIGNAL_FLOOR, 0.35);
});

test('a tool_result hop reporting completed is a task boundary', () => {
  assert.ok(isTaskBoundary({ role: 'tool', hop: 'tool_result', content: 'ran', meta: { status: 'completed' } }));
  assert.ok(!isTaskBoundary({ role: 'tool', hop: 'tool_call', content: 'calling', meta: {} }));
});
