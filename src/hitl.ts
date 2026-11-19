/**
 * Human in the loop — the same scores, one more use.
 *
 * Most rubrics only remember. A rubric with an `alert` threshold also *asks*:
 * when an extraction's confidence crosses it, the engine raises one card with
 * three answers, and the agent loop wrapping the memory can pause until the
 * person responds. This is a thin hook on Tier 2's scores, not a second system —
 * the engine that decides what to *remember* is the one that decides when to
 * *ask*. The answer is recorded on the audit tree (actor `human`) and settles
 * the card so the same decision is never raised twice.
 */
import type { Fact } from './store';

export type Answer = 'keep_going' | 'pause' | 'correct';

export interface Card {
  /** Decision identity — settled once answered, never re-raised. */
  print: string;
  rubric: string;
  /** The one sentence a person reads. */
  says: string;
  confidence: number;
  /** The alert threshold that was crossed. */
  alert: number;
  sourceTurn: number;
  answers: Answer[];
}

export const ANSWERS: Answer[] = ['keep_going', 'pause', 'correct'];

export const cardPrint = (rubric: string, factText: string): string =>
  `${rubric}:${factText.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 48)}`;

/** Build the card for an extracted fact that crossed its rubric's alert gate. */
export function raiseCard(fact: Fact, alert: number): Card {
  return {
    print: cardPrint(fact.rubric ?? 'signal', fact.text),
    rubric: fact.rubric ?? 'signal',
    says: fact.text,
    confidence: fact.confidence ?? 1,
    alert,
    sourceTurn: fact.sourceTurn,
    answers: ANSWERS,
  };
}
