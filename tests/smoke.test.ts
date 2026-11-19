import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VERSION, estimateTokens } from '../src/index';

test('the package exposes its version', () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});

test('estimateTokens scales with length and never returns zero', () => {
  assert.equal(estimateTokens(''), 1);
  assert.equal(estimateTokens('abcd'), 1);
  assert.ok(estimateTokens('a'.repeat(400)) === 100);
  assert.ok(estimateTokens('a'.repeat(4000)) > estimateTokens('a'.repeat(400)));
});
