/**
 * Triolima — memory for AI agents that remembers by meaning, not age.
 *
 * This barrel is intentionally small at the scaffold stage: it fixes the public
 * vocabulary (the types every tier shares) and ships one real, tested utility.
 * The engine lands tier by tier in the commits that follow, each exporting
 * through here. Keeping the shared types here from the start means the tiers are
 * built against one agreed shape rather than drifting apart.
 */

export const VERSION = '0.1.0';

/** Who performed a memory operation. Every commit on the audit tree has one. */
export type Actor = 'agent' | 'pin' | 'rubric' | 'ranker' | 'human';

/** One message in a conversation — the unit Tier 1 reads. */
export interface Turn {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  /** Optional structured result for a tool turn, e.g. { status: 'completed' }. */
  meta?: Record<string, unknown>;
}

/** A business rubric: cues that signal it, and the confidence gate to extract. */
export interface Rubric {
  name: string;
  cues: string[];
  /** 0–1. A slice scoring at or above this is extracted into verified state. */
  threshold: number;
  /** Relative importance in the disclosure ranker. Defaults to 1. */
  weight?: number;
}

/** The three-slider disclosure budget that keeps the prompt bounded. */
export interface Budget {
  /** Layer 1: how many facts the always-on header may hold. */
  hotFacts: number;
  /** Layer 2: how many items hybrid retrieval returns per turn. */
  retrieveK: number;
  /** Turns of disuse after which a fact's rank halves. */
  halfLifeTurns: number;
}

/** How a memory instance is configured. */
export interface Config {
  /** Hard-fact patterns; a match is pinned verbatim, forever. */
  pins: RegExp[];
  rubrics: Rubric[];
  budget: Budget;
}

/**
 * Estimate the token cost of a string.
 *
 * A deliberately dependency-free heuristic (~4 characters per token) — good
 * enough to hold the disclosure budget and to show the bounded-cost contrast
 * against a naive window. A tokeniser can be swapped in later without changing
 * any caller, because every tier measures cost through this one function.
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
