/**
 * The shared vocabulary every tier is built against. Kept in one file so the
 * tiers agree on shape and never drift apart.
 */

/**
 * Who performed a memory operation. Every commit on the audit tree has one.
 * The actor names the worker; the event's `op` names what it did.
 *   agent    — the conversation itself (a turn arrived)
 *   fastpath — Tier 1: pin, fold, prune (synchronous, deterministic)
 *   rubric   — Tier 2: score and extract (asynchronous)
 *   ranker   — disclosure: what goes in the hot header this turn
 *   human    — a person's answer to a card
 */
export type Actor = 'agent' | 'fastpath' | 'rubric' | 'ranker' | 'human';

/**
 * Which hop of the agent loop an event came from. When the host owns the loop
 * (our demo over the Anthropic API), it instruments all four directly; an
 * external-runtime adapter (Claude Code via hooks/OTLP) maps onto the same set.
 */
export type Hop = 'input' | 'tool_call' | 'tool_result' | 'output';

/** One event in a conversation — the unit Tier 1 reads. Any hop, not just a chat turn. */
export interface Turn {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  /** Which hop this came from, when the host instruments at that granularity. */
  hop?: Hop;
  /** Optional structured result for a tool event, e.g. { status: 'completed' }. */
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
  /**
   * 0–1, optional and at or above `threshold`. When an extraction's confidence
   * crosses this, the engine raises a human-in-the-loop card: the wrapping loop
   * can pause and ask before continuing. Omit for a rubric that only remembers.
   */
  alert?: number;
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
