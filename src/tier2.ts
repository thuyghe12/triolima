/**
 * Tier 2 — asynchronous rubric extraction.
 *
 * Tier 1 catches explicit, structured facts. Tier 2 catches *meaning*: a root
 * cause stated in prose, a commitment, a risk, a frustrated customer. It runs
 * off the hot path — at a task boundary — so its cost never lands on the live
 * turn. Each rubric scores the completed slice; only a score at or above the
 * rubric's threshold is extracted into verified state, tagged with the rubric,
 * the confidence and the source turn. A below-threshold score is recorded as a
 * "hold", so even the non-decisions are auditable.
 *
 * The scorer here is a transparent heuristic (cue coverage, nudged by numeric
 * evidence). It is intentionally model-free and deterministic so the library
 * runs and tests without a key; it sits behind one function, so a real
 * small-model scorer (a structured-output call) can replace it without changing
 * the gate, the store, or the trace.
 */
import type { Rubric, Turn } from './types';
import type { Tree } from './tree';
import type { Fact, Store } from './store';

/** Score a rubric against text, in [0,1]. Transparent and model-free. */
export function scoreRubric(rubric: Rubric, text: string): number {
  const low = text.toLowerCase();
  let hit = 0;
  for (const cue of rubric.cues) if (low.includes(cue.toLowerCase())) hit += 1;
  if (!hit) return 0;
  const coverage = hit / Math.max(2, Math.ceil(rubric.cues.length * 0.5));
  const numeric = /\d/.test(text) ? 0.12 : 0;
  return Math.max(0, Math.min(1, 0.45 + coverage * 0.4 + numeric));
}

/** The one line a rubric extracts: the sentence carrying a cue, trimmed. */
export function extractFact(rubric: Rubric, text: string): string {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const carrying = sentences.find((s) => rubric.cues.some((c) => s.toLowerCase().includes(c.toLowerCase())));
  return (carrying ?? text).replace(/\s+/g, ' ').trim().slice(0, 140);
}

export interface Consolidation {
  extracted: Fact[];
  /** Rubrics that fired but did not clear the gate, for the trace. */
  held: Array<{ rubric: string; confidence: number; threshold: number }>;
}

/**
 * Score a completed slice against every rubric and extract what clears the gate.
 * Records each extraction (actor 'rubric', op 'extract') and each hold on the
 * tree. Synchronous in signature so it is trivial to test; the engine runs it
 * off the hot path.
 */
export function consolidate(
  slice: Turn[],
  rubrics: Rubric[],
  store: Store,
  tree: Tree,
  at: number,
): Consolidation {
  const text = slice.map((t) => t.content).join('\n');
  const extracted: Fact[] = [];
  const held: Consolidation['held'] = [];

  for (const rubric of rubrics) {
    const confidence = scoreRubric(rubric, text);
    if (confidence <= 0) continue;
    if (confidence >= rubric.threshold) {
      const fact = store.add({
        kind: 'verified',
        text: extractFact(rubric, text),
        rubric: rubric.name,
        confidence,
        weight: rubric.weight ?? 1,
        sourceTurn: at,
      });
      extracted.push(fact);
      tree.commit({
        actor: 'rubric', op: 'extract',
        summary: `${rubric.name} ${confidence.toFixed(2)} ≥ ${rubric.threshold.toFixed(2)} → "${fact.text.slice(0, 60)}"`,
        data: { rubric: rubric.name, confidence, threshold: rubric.threshold, factId: fact.id }, at,
      });
    } else {
      held.push({ rubric: rubric.name, confidence, threshold: rubric.threshold });
      tree.commit({
        actor: 'rubric', op: 'hold',
        summary: `${rubric.name} ${confidence.toFixed(2)} < ${rubric.threshold.toFixed(2)} — held`,
        data: { rubric: rubric.name, confidence, threshold: rubric.threshold }, at,
      });
    }
  }
  return { extracted, held };
}
