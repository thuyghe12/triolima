import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTree, contentId } from '../src/tree';

test('a commit chains to the previous head', () => {
  const tree = createTree();
  assert.equal(tree.head(), null);
  const a = tree.commit({ actor: 'pin', op: 'pin', summary: 'pinned INC-5120', data: {}, at: 1 });
  assert.equal(a.parent, null);
  const b = tree.commit({ actor: 'rubric', op: 'extract', summary: 'root cause', data: {}, at: 2 });
  assert.equal(b.parent, a.id);
  assert.equal(tree.head(), b.id);
  assert.equal(tree.log().length, 2);
});

test('ids are content-addressed and stable', () => {
  const s = 'parent|pin|pin|summary|{}|1';
  assert.equal(contentId(s), contentId(s));
  assert.notEqual(contentId(s), contentId(s + 'x'));
  assert.match(contentId(s), /^[0-9a-f]{16}$/);
});

test('changing history changes every later id (tamper-evident)', () => {
  const build = (firstSummary: string) => {
    const t = createTree();
    t.commit({ actor: 'pin', op: 'pin', summary: firstSummary, data: {}, at: 1 });
    return t.commit({ actor: 'rubric', op: 'extract', summary: 'same later commit', data: {}, at: 2 }).id;
  };
  assert.notEqual(build('original'), build('tampered'));
});

test('byActor filters the log', () => {
  const tree = createTree();
  tree.commit({ actor: 'pin', op: 'pin', summary: 'a', data: {}, at: 1 });
  tree.commit({ actor: 'human', op: 'answer', summary: 'keep going', data: {}, at: 1 });
  tree.commit({ actor: 'pin', op: 'pin', summary: 'b', data: {}, at: 2 });
  assert.equal(tree.byActor('pin').length, 2);
  assert.equal(tree.byActor('human').length, 1);
});
