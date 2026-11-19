/**
 * createMemory — the engine, and the whole public surface.
 *
 * Three calls wrap any agent loop:
 *   observe(turn)        Tier 1, synchronous: pin, prune, record the turn.
 *   consolidate()        Tier 2, at a task boundary: fold, then extract.
 *   assemble(query)      disclosure: a bounded context + a full trace.
 *
 * consolidate and assemble are async by contract — today they run in-process,
 * but the seams (a real model scorer in Tier 2, a vector index in retrieval)
 * are I/O, and making the contract async now means swapping either in later
 * changes no caller. The engine owns turn counting and the open slice (the
 * turns since the last consolidation); the tiers stay pure.
 */
import type { Config, Turn } from './types';
import type { Tree } from './tree';
import { createTree } from './tree';
import type { Store, Fact } from './store';
import { inMemory } from './store';
import { runTier1, foldReceipt, isTaskBoundary, type Tier1Result } from './tier1';
import { consolidate as runTier2, type Consolidation } from './tier2';
import { assemble as runAssemble, type AssembledContext } from './disclosure';

/** Pins rank above verified facts; this weight is for any later use of theirs. */
const PIN_WEIGHT = 3;

export interface Memory {
  /** Tier 1 on a turn. Returns what the fast path did; records it on the tree. */
  observe: (turn: Turn) => Tier1Result;
  /** Tier 2 on the open slice: fold the finished task, extract, reset the slice. */
  consolidate: () => Promise<Consolidation>;
  /** Disclosure for a query: Layer 1 + Layer 2, bounded, with the trace. */
  assemble: (query: string) => Promise<AssembledContext>;
  /** The audit tree and the store, for review and the demo. */
  readonly tree: Tree;
  readonly store: Store;
  /** The current turn number. */
  turn: () => number;
}

export function createMemory(config: Config, deps: { store?: Store; tree?: Tree } = {}): Memory {
  const tree = deps.tree ?? createTree();
  const store = deps.store ?? inMemory();
  let turnNo = 0;
  let slice: Turn[] = [];

  const observe = (turn: Turn): Tier1Result => {
    turnNo += 1;
    tree.commit({ actor: 'agent', op: 'turn', summary: `${turn.role}: ${turn.content.slice(0, 60)}`, data: { role: turn.role }, at: turnNo });

    const result = runTier1(turn, config.pins, tree, turnNo);
    for (const pin of result.pins) {
      store.add({ kind: 'pin', text: pin.value, pattern: pin.pattern, weight: PIN_WEIGHT, sourceTurn: turnNo });
    }
    // A pruned turn leaves no trace in working memory (only the audit record);
    // everything else joins the open slice for Tier 2 to weigh.
    if (!result.pruned) slice.push(turn);
    return result;
  };

  const consolidate = async (): Promise<Consolidation> => {
    if (!slice.length) return { extracted: [], held: [] };
    if (slice.some(isTaskBoundary)) {
      tree.commit({ actor: 'fastpath', op: 'fold', summary: foldReceipt(slice), data: { steps: slice.length }, at: turnNo });
    }
    const result = runTier2(slice, config.rubrics, store, tree, turnNo);
    slice = [];
    return result;
  };

  const assemble = async (query: string): Promise<AssembledContext> =>
    runAssemble(query, store, config.budget, tree, turnNo);

  return { observe, consolidate, assemble, tree, store, turn: () => turnNo };
}

export type { Fact };
