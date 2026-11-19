import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemory } from '../src/memory';
import { cardPrint } from '../src/hitl';
import type { Config } from '../src/types';

const config = (): Config => ({
  pins: [/INC-\d+/],
  rubrics: [
    // A remember-only rubric, and an alerting one.
    { name: 'root cause', cues: ['root cause', 'traced to'], threshold: 0.8 },
    { name: 'security risk', cues: ['secret', 'leaked', 'credential', 'exposed'], threshold: 0.75, alert: 0.75 },
  ],
  budget: { hotFacts: 8, retrieveK: 4, halfLifeTurns: 6 },
});

test('an alerting rubric raises a card; a remember-only one does not', async () => {
  const m = createMemory(config());
  m.observe({ role: 'user', content: 'root cause traced to a retry storm.' });
  m.observe({ role: 'user', content: 'Also the API credential was leaked and exposed in logs. Resolved.' });
  const con = await m.consolidate();

  assert.ok(con.extracted.some((f) => f.rubric === 'root cause'), 'root cause remembered');
  assert.equal(con.cards.length, 1, 'exactly one card raised');
  assert.equal(con.cards[0]!.rubric, 'security risk');
  assert.deepEqual(con.cards[0]!.answers, ['keep_going', 'pause', 'correct']);
  assert.equal(m.pending().length, 1, 'the card is pending until answered');
});

test('answering settles the card and records who decided', async () => {
  const m = createMemory(config());
  m.observe({ role: 'user', content: 'A credential was exposed in the diff. Applied.' });
  const con = await m.consolidate();
  const card = con.cards[0]!;

  const res = m.answer(card.print, 'correct', 'Rotate the key and scrub the logs first.');
  assert.equal(res.text, 'Rotate the key and scrub the logs first.', 'correct returns its text to resume with');
  assert.equal(m.pending().length, 0, 'no longer pending');

  const human = m.tree.byActor('human');
  assert.equal(human.length, 1);
  assert.match(human[0]!.summary, /correct: Rotate the key/);
});

test('a settled decision is never raised again', async () => {
  const m = createMemory(config());
  m.observe({ role: 'user', content: 'secret leaked and exposed. done.' });
  const first = await m.consolidate();
  const card = first.cards[0]!;
  m.answer(card.print, 'keep_going');

  // The same signal recurs on a later turn with the same identity.
  m.observe({ role: 'user', content: 'secret leaked and exposed. done.' });
  const second = await m.consolidate();
  assert.equal(second.cards.length, 0, 'the settled card does not come back');
});

test('cardPrint is stable for the same decision', () => {
  assert.equal(cardPrint('risk', 'A secret   was exposed'), cardPrint('risk', 'a secret was exposed'));
});
