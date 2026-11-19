/**
 * Triolima — memory for AI agents that remembers by meaning, not age.
 *
 * The public barrel. Each tier exports through here as it lands, so callers have
 * one import and the shared vocabulary stays in one place.
 */
export const VERSION = '0.1.0';

export type { Actor, Hop, Turn, Rubric, Budget, Config } from './types';
export { estimateTokens } from './tokens';
export { createTree, contentId, type Tree, type MemoryEvent } from './tree';
export {
  entropy, isLowSignal, findPins, isTaskBoundary, foldReceipt, runTier1,
  SIGNAL_FLOOR, type PinHit, type Tier1Result,
} from './tier1';
export { inMemory, factKey, type Store, type Fact, type NewFact } from './store';
export { scoreRubric, extractFact, consolidate, type Consolidation } from './tier2';
export {
  rankHot, decayScore, hybridRetrieve, assemble,
  type RankedFact, type ScoredFact, type AssembledContext,
} from './disclosure';
export { createMemory, type Memory } from './memory';
export { raiseCard, cardPrint, ANSWERS, type Card, type Answer } from './hitl';
