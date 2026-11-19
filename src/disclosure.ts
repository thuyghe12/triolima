/**
 * Disclosure — inject just enough.
 *
 * The archive can hold thousands of facts; the prompt must not. Disclosure is
 * the ranker that keeps per-turn cost bounded no matter how much is remembered:
 *
 *   Layer 1 — the hot header. Pins first (hard facts, always), then verified
 *             facts by a utility-weighted decay score, sliced to the budget.
 *   Layer 2 — hybrid retrieval. For this turn's query, the most relevant facts
 *             NOT already in the header, by keyword + vector similarity.
 *   Layer 3 — the deep archive. Everything else, never injected; reachable only
 *             by an explicit tool call.
 *
 * The ranking formula is explicit, not a black box:
 *   score = (confidence × weight) × 2^(−(turn − lastUsed) / halfLife)
 * Use a fact and its clock resets; leave it and it fades out of the header
 * without being deleted.
 */
import type { Budget } from './types';
import type { Fact, Store } from './store';
import type { Tree, MemoryEvent } from './tree';
import { estimateTokens } from './tokens';

export interface RankedFact extends Fact {
  /** The ranking score; pins sort above every verified fact. */
  score: number;
}
export interface ScoredFact extends Fact {
  /** Retrieval relevance in [0,1]. */
  relevance: number;
}

const PIN_SCORE = Number.POSITIVE_INFINITY;

/** The decay-weighted rank of a verified fact at a given turn. */
export function decayScore(fact: Fact, turn: number, halfLife: number): number {
  const since = Math.max(0, turn - fact.lastUsed);
  const base = (fact.confidence ?? 1) * fact.weight;
  return base * Math.pow(2, -since / Math.max(1, halfLife));
}

/** Layer 1: pins first, then verified by decay, sliced to the budget. */
export function rankHot(facts: Fact[], budget: Budget, turn: number): RankedFact[] {
  const ranked: RankedFact[] = facts.map((f) => ({
    ...f,
    score: f.kind === 'pin' ? PIN_SCORE : decayScore(f, turn, budget.halfLifeTurns),
  }));
  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, budget.hotFacts);
}

// --- hybrid retrieval ------------------------------------------------------

function vector(text: string): Map<string, number> {
  const v = new Map<string, number>();
  for (const w of text.toLowerCase().match(/[a-z0-9\-]+/g) ?? []) {
    if (w.length < 2) continue;
    v.set(w, (v.get(w) ?? 0) + 1);
  }
  return v;
}
function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0, na = 0, nb = 0;
  for (const [k, va] of a) { na += va * va; const vb = b.get(k); if (vb) dot += va * vb; }
  for (const vb of b.values()) nb += vb * vb;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Layer 2: the top-k most relevant facts for a query, by vector + keyword. */
export function hybridRetrieve(query: string, facts: Fact[], k: number): ScoredFact[] {
  const qv = vector(query);
  const qWords = new Set(qv.keys());
  return facts
    .map((f) => {
      const fv = vector(f.text);
      let overlap = 0;
      for (const w of fv.keys()) if (qWords.has(w)) overlap += 1;
      const relevance = cosine(qv, fv) + Math.min(0.2, overlap * 0.03);
      return { ...f, relevance };
    })
    .filter((f) => f.relevance > 0.02)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, k);
}

// --- assemble --------------------------------------------------------------

export interface AssembledContext {
  /** Layer 1 — always injected. */
  header: RankedFact[];
  /** Layer 2 — retrieved for this turn. */
  retrieved: ScoredFact[];
  /** Layer 3 — count held but not injected. */
  archiveSize: number;
  /** Estimated tokens of the assembled memory (header + retrieved + scaffold). */
  tokens: number;
  /** The disclosure commits recorded for this turn. */
  trace: MemoryEvent[];
}

/** A rough, fixed overhead for the header's framing text. */
const SCAFFOLD_TOKENS = 40;

/**
 * Build the bounded context for a query. Facts that make the cut are touched
 * (their decay clock resets), and the ranker records what it surfaced on the
 * tree, so the choice is auditable.
 */
export function assemble(query: string, store: Store, budget: Budget, tree: Tree, turn: number): AssembledContext {
  const header = rankHot(store.all(), budget, turn);
  const inHeader = new Set(header.map((f) => f.id));
  const rest = store.all().filter((f) => !inHeader.has(f.id));
  const retrieved = hybridRetrieve(query, rest, budget.retrieveK);

  for (const f of [...header, ...retrieved]) store.touch(f.id, turn);

  const tokens =
    header.reduce((t, f) => t + estimateTokens(f.text), 0) +
    retrieved.reduce((t, f) => t + estimateTokens(f.text), 0) +
    SCAFFOLD_TOKENS;

  const event = tree.commit({
    actor: 'ranker', op: 'assemble',
    summary: `header ${header.length}/${budget.hotFacts}, retrieved ${retrieved.length}, archive ${store.all().length} → ${tokens} tok`,
    data: {
      header: header.map((f) => ({ text: f.text, score: f.score })),
      retrieved: retrieved.map((f) => ({ text: f.text, relevance: f.relevance })),
      tokens,
    },
    at: turn,
  });

  return { header, retrieved, archiveSize: store.all().length, tokens, trace: [event] };
}
