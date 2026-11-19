/**
 * The agent loop, exercised end-to-end with a scripted model — so CI proves the
 * wiring (real per-hop spans, memory governing the prompt, the recall tool, the
 * content-raised human card) with no key and no network. The app always runs a
 * real model; this only guards the plumbing around it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, type LoopEvent, type Span } from '../demo/agent/loop';
import { scripted } from '../demo/agent/provider';

const spans = (events: LoopEvent[]): Span[] =>
  events.filter((e): e is Extract<LoopEvent, { kind: 'span' }> => e.kind === 'span').map((e) => e.span);

test('instruments every hop as a span, pins identifiers, and runs recall', async () => {
  const events: LoopEvent[] = [];
  const provider = scripted([
    { text: 'Let me check.', toolCalls: [{ id: 't1', name: 'recall', input: { query: 'email' } }] },
    { text: 'Your email is on file.' },
  ]);
  const session = createSession({ provider, emit: (e) => events.push(e), askHuman: () => Promise.resolve({ answer: 'keep_going' }) });

  await session.say('My email is a@b.com and my name is Thomas.');

  // Identifiers (code watcher) pinned the email verbatim.
  assert.ok(session.memory.store.pins().some((p) => p.text.includes('@')), 'email pinned');

  // Real per-hop spans, not just input/output.
  const kinds = new Set(spans(events).map((s) => s.kind));
  for (const k of ['input', 'memory', 'llm', 'tool', 'output'] as const) {
    assert.ok(kinds.has(k), `expected a ${k} span`);
  }
  // A watcher span classified by tier.
  assert.ok(spans(events).some((s) => s.kind === 'watcher' && s.tier === 'code'), 'a code-tier watcher span');

  // recall actually ran.
  assert.ok(events.some((e) => e.kind === 'tool_call' && e.name === 'recall'));
  assert.ok(events.some((e) => e.kind === 'tool_result'));

  // The disclosed prompt stays bounded; the baseline is tracked.
  const stats = events.filter((e): e is Extract<LoopEvent, { kind: 'stat' }> => e.kind === 'stat');
  const last = stats[stats.length - 1];
  assert.ok(last && last.naiveTokens > 0 && last.memoryTokens < 600);
});

test('a sensitive action raises a card, and pause stops the turn', async () => {
  const events: LoopEvent[] = [];
  const provider = scripted([{ text: 'should not run' }]);
  const session = createSession({ provider, emit: (e) => events.push(e), askHuman: () => Promise.resolve({ answer: 'pause' }) });

  await session.say('Please delete my account now.');

  assert.ok(events.some((e) => e.kind === 'card'), 'a card was raised for the sensitive action');
  assert.ok(session.memory.tree.byActor('human').length >= 1, 'the human answer is on the tree');
  assert.ok(!events.some((e) => e.kind === 'assistant'), 'the model never ran after pause');
});

test('correct records the note and lets the turn continue', async () => {
  const events: LoopEvent[] = [];
  const provider = scripted([{ text: 'Understood.' }]);
  const session = createSession({ provider, emit: (e) => events.push(e), askHuman: () => Promise.resolve({ answer: 'correct', text: 'archive it instead' }) });

  await session.say('delete the project');

  assert.ok(events.some((e) => e.kind === 'card'));
  assert.ok(events.some((e) => e.kind === 'notice' && /archive it instead/.test(e.text)));
  assert.ok(events.some((e) => e.kind === 'assistant'), 'the turn continued after the correction');
});
