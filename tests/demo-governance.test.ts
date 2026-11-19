/**
 * The demo's memory governance — the watchers the agent runs on every turn —
 * exercised directly on the engine, with no model and no Agent SDK subprocess.
 * This guards the rubric → engine wiring (what each tier does) in CI; the live
 * agent integration (demo/agent/run.ts) is validated by typecheck and a real run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemory } from '../src/index';
import { configFrom, WATCHERS } from '../demo/agent/config';

test('code tier — identifiers are pinned verbatim', () => {
  const m = createMemory(configFrom(WATCHERS));
  m.observe({ role: 'user', content: 'My email is a@b.com and ticket ABC-12 is open.', hop: 'input' });
  assert.ok(m.store.pins().some((p) => p.text.includes('@')), 'email pinned');
  assert.ok(m.store.pins().some((p) => /ABC-12/.test(p.text)), 'ticket id pinned');
});

test('decision tier — a stated preference is extracted', async () => {
  const m = createMemory(configFrom(WATCHERS));
  m.observe({ role: 'user', content: 'I prefer dark mode and always use tabs.', hop: 'input' });
  await m.consolidate();
  assert.ok(m.store.verified().some((f) => f.rubric === 'Preferences'), 'preference extracted');
});

test('human tier — a sensitive action raises a card', async () => {
  const m = createMemory(configFrom(WATCHERS));
  m.observe({ role: 'user', content: 'please delete my account', hop: 'input' });
  await m.consolidate();
  assert.ok(m.pending().length >= 1, 'a card is raised for the sensitive action');
});

test('disabling a watcher removes it from the engine config', () => {
  const off = WATCHERS.map((w) => (w.id === 'identifiers' ? { ...w, enabled: false } : w));
  const cfg = configFrom(off);
  assert.equal(cfg.pins.length, 0, 'identifiers pins are gone when disabled');
});
