import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreRubric, extractFact, consolidate } from '../src/tier2';
import { inMemory, factKey } from '../src/store';
import { createTree } from '../src/tree';
import type { Rubric, Turn } from '../src/types';

const ROOT: Rubric = { name: 'root cause', cues: ['root cause', 'traced to', 'because'], threshold: 0.8 };
const IMPACT: Rubric = { name: 'impact', cues: ['users', 'impact', 'failed', 'orders'], threshold: 0.75 };

test('scoreRubric rises with cue coverage and numeric evidence', () => {
  assert.equal(scoreRubric(ROOT, 'nothing relevant here'), 0);
  const weak = scoreRubric(ROOT, 'the root cause is unclear');
  const strong = scoreRubric(ROOT, 'root cause traced to Stripe timeout, 2s latency');
  assert.ok(strong > weak);
  assert.ok(strong <= 1);
});

test('extractFact returns the sentence carrying a cue', () => {
  const text = 'We looked around. The root cause was a connection pool exhaustion. Then we moved on.';
  assert.match(extractFact(ROOT, text), /connection pool exhaustion/);
});

test('consolidate extracts above the gate and holds below it', () => {
  const store = inMemory();
  const tree = createTree();
  const slice: Turn[] = [
    { role: 'user', content: 'payments-api 503s traced to Stripe timeout — that is the root cause. ~340 orders failed.' },
  ];
  const { extracted, held } = consolidate(slice, [ROOT, IMPACT], store, tree, 4);
  const names = extracted.map((f) => f.rubric);
  assert.ok(names.includes('root cause'), `extracted: ${names.join(',')}`);
  assert.ok(store.verified().length === extracted.length && extracted.length >= 1);
  // Every extraction carries provenance.
  const f = extracted[0]!;
  assert.ok(f.confidence && f.confidence >= 0.8 && f.rubric && f.sourceTurn === 4);
  // The tree recorded extractions (and any holds).
  const ops = tree.byActor('rubric').map((e) => e.op);
  assert.ok(ops.includes('extract'));
  assert.equal(held.length + extracted.length, tree.byActor('rubric').length);
});

test('a fact is never stored twice', () => {
  const store = inMemory();
  const a = store.add({ kind: 'verified', text: 'Root cause: pool exhaustion', rubric: 'root cause', confidence: 0.9, weight: 1, sourceTurn: 2 });
  const b = store.add({ kind: 'verified', text: 'root cause:   pool exhaustion', rubric: 'root cause', confidence: 0.9, weight: 1, sourceTurn: 5 });
  assert.equal(a.id, b.id, 'de-duped by identity');
  assert.equal(store.verified().length, 1);
});

test('touch resets the usage clock', () => {
  const store = inMemory();
  const f = store.add({ kind: 'pin', text: 'INC-5120', pattern: 'INC-\\d+', weight: 3, sourceTurn: 1 });
  assert.equal(f.uses, 0);
  store.touch(f.id, 9);
  assert.equal(store.get(f.id)!.lastUsed, 9);
  assert.equal(store.get(f.id)!.uses, 1);
});

test('factKey separates pins from verified', () => {
  assert.notEqual(
    factKey({ kind: 'pin', pattern: 'INC-\\d+', text: 'INC-1' }),
    factKey({ kind: 'verified', rubric: 'x', text: 'INC-1' }),
  );
});
