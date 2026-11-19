import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measure, makeScenario } from '../bench/compare';

test('the benchmark claim holds: bounded cost AND full recall', async () => {
  const rows = await measure(makeScenario(120));
  const by = (s: string) => rows.find((r) => r.strategy === s)!;
  const full = by('naive-full');
  const win = by('naive-window(12)');
  const tri = by('triolima');

  // Naive full history has perfect recall but unbounded, large cost.
  assert.equal(full.recall, 1);
  assert.ok(full.finalTokens > 1500, `naive-full was only ${full.finalTokens} tokens`);

  // A sliding window is cheap but has forgotten the turn-1 facts.
  assert.ok(win.recall < 1, `window recall was ${win.recall}`);

  // Triolima: bounded like a window, recall like the full history.
  assert.equal(tri.recall, 1, 'triolima recalled every critical fact');
  assert.ok(tri.finalTokens < 400, `triolima final was ${tri.finalTokens} tokens`);
  assert.ok(tri.finalTokens < full.finalTokens / 4, 'triolima is far smaller than full history');
});
