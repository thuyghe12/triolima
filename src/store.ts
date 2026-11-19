/**
 * The store: where remembered facts live between turns.
 *
 * Two kinds of fact share one shape — pins (hard facts, from Tier 1) and
 * verified facts (business signals, from Tier 2) — each carrying its provenance
 * and a small usage record the disclosure ranker reads (last used, how often).
 * The store is an interface so a team can back it with Cosmos, Redis or Postgres
 * without touching a tier; the default keeps everything in memory, which is all
 * the library, the tests and the demo need.
 *
 * "The archive" in the three-layer model is simply `all()` — everything held
 * here. Disclosure decides what of it reaches the prompt; nothing is deleted to
 * stay bounded, it just falls out of the hot header.
 */
import { contentId } from './tree';

export interface Fact {
  id: string;
  kind: 'pin' | 'verified';
  text: string;
  /** Verified only: the rubric that extracted it and its confidence. */
  rubric?: string;
  confidence?: number;
  /** Relative importance in the ranker. */
  weight: number;
  /** Pin only: the pattern that matched. */
  pattern?: string;
  /** The turn this came from, and the turn it was created. */
  sourceTurn: number;
  /** Usage, for utility-weighted decay. */
  lastUsed: number;
  uses: number;
}

export type NewFact = Omit<Fact, 'id' | 'lastUsed' | 'uses'> & { lastUsed?: number };

export interface Store {
  /** Add a fact, de-duped by identity; returns the stored (or existing) fact. */
  add: (fact: NewFact) => Fact;
  /** Everything held — the deep archive. */
  all: () => Fact[];
  pins: () => Fact[];
  verified: () => Fact[];
  /** Mark a fact used this turn, so its decay clock resets. */
  touch: (id: string, turn: number) => void;
  get: (id: string) => Fact | undefined;
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Stable identity so the same fact is never stored twice. */
export function factKey(f: Pick<Fact, 'kind' | 'rubric' | 'pattern' | 'text'>): string {
  return f.kind === 'pin'
    ? `pin:${f.pattern ?? ''}:${norm(f.text)}`
    : `ver:${f.rubric ?? ''}:${norm(f.text).slice(0, 80)}`;
}

export function inMemory(): Store {
  const byKey = new Map<string, Fact>();
  const byId = new Map<string, Fact>();

  const add = (f: NewFact): Fact => {
    const key = factKey(f);
    const existing = byKey.get(key);
    if (existing) return existing;
    const fact: Fact = { ...f, id: contentId(key), lastUsed: f.lastUsed ?? f.sourceTurn, uses: 0 };
    byKey.set(key, fact);
    byId.set(fact.id, fact);
    return fact;
  };

  return {
    add,
    all: () => [...byId.values()],
    pins: () => [...byId.values()].filter((f) => f.kind === 'pin'),
    verified: () => [...byId.values()].filter((f) => f.kind === 'verified'),
    touch: (id, turn) => {
      const f = byId.get(id);
      if (f) { f.lastUsed = turn; f.uses += 1; }
    },
    get: (id) => byId.get(id),
  };
}
