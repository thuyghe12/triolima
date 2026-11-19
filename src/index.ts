/**
 * Triolima — memory for AI agents that remembers by meaning, not age.
 *
 * The public barrel. Each tier exports through here as it lands, so callers have
 * one import and the shared vocabulary stays in one place.
 */
export const VERSION = '0.1.0';

export type { Actor, Turn, Rubric, Budget, Config } from './types';
export { estimateTokens } from './tokens';
export { createTree, contentId, type Tree, type MemoryEvent } from './tree';
