/**
 * Estimate the token cost of a string.
 *
 * A deliberately dependency-free heuristic (~4 characters per token) — good
 * enough to hold the disclosure budget and to show the bounded-cost contrast
 * against a naive window. A real tokeniser can be swapped in later without
 * changing any caller, because every tier measures cost through this one
 * function.
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
