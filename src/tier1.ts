/**
 * Tier 1 — the synchronous fast path.
 *
 * Runs on every turn, in the hot path, so it is pure, deterministic, and calls
 * no model: regex, counters, a cheap signal score. Under ~2ms, $0. It does the
 * three things that keep working memory sharp without waiting for anything:
 *
 *   PIN   — a turn matching a hard-fact pattern is locked in, verbatim, forever.
 *   PRUNE — a low-signal turn (filler, "thanks, got it") is dropped first.
 *   FOLD  — when a sub-task completes, its scaffolding collapses to one receipt.
 *
 * Everything here is exported as a plain function so it can be tested in
 * isolation and composed by the engine; `runTier1` is the one that also records
 * what it did on the audit tree.
 */
import type { Turn } from './types';
import type { Tree } from './tree';

export interface PinHit {
  /** The pattern that matched (its source), for the audit trail. */
  pattern: string;
  /** The exact matched text, kept verbatim. */
  value: string;
}

/** Below this signal score a turn is filler and is pruned first. */
export const SIGNAL_FLOOR = 0.35;

// Words that carry no signal, and words that signal real action.
const FILLER = new Set(['ok', 'okay', 'cool', 'thanks', 'thank', 'you', 'great', 'sure', 'sec',
  'give', 'me', 'a', 'the', 'to', 'and', 'so', 'got', 'it', 'hi', 'hey', 'please', 'just', 'let',
  'up', 'yeah', 'yep', 'nice', 'perfect', 'awesome', 'of', 'for', 'is', 'on', 'that', 'this']);
const ACTION = new Set(['applying', 'apply', 'applied', 'enabling', 'enabled', 'confirmed', 'confirm',
  'deploying', 'deployed', 'set', 'setting', 'raise', 'raised', 'check', 'checked', 'traced', 'opened',
  'updated', 'dropping', 'dropped', 'fix', 'fixed', 'mitigated', 'resolved', 'rolled', 'reverted']);

/**
 * A zero-LLM signal score in [0,1]. Dense turns (ids, numbers, action verbs,
 * unique content words) score high; conversational filler scores low. The
 * weights are deliberately simple so the score is explainable and reproducible.
 */
export function entropy(text: string): number {
  const words = text.toLowerCase().match(/[a-z0-9][a-z0-9.\-/]*/g) ?? [];
  if (!words.length) return 0;
  let signal = 0;
  const unique = new Set<string>();
  for (const w of words) {
    if (/\d/.test(w)) signal += 1.4;          // numbers / ids
    else if (ACTION.has(w)) signal += 1.1;     // action verbs
    else if (FILLER.has(w)) signal += 0;       // filler
    else { signal += 0.5; unique.add(w); }     // content words
  }
  const density = (signal + unique.size * 0.25) / words.length;
  return Math.max(0, Math.min(1, density / 1.3));
}

export function isLowSignal(text: string, floor = SIGNAL_FLOOR): boolean {
  return entropy(text) < floor;
}

/** Every hard fact in a turn, from the configured pin patterns. */
export function findPins(text: string, pins: RegExp[]): PinHit[] {
  const hits: PinHit[] = [];
  const seen = new Set<string>();
  for (const re of pins) {
    const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    for (const m of text.matchAll(global)) {
      const value = m[0].trim();
      const key = `${re.source}::${value}`;
      if (value && !seen.has(key)) { seen.add(key); hits.push({ pattern: re.source, value }); }
    }
  }
  return hits;
}

/** A completed sub-task: a tool turn that reports done, or a clear close phrase. */
export function isTaskBoundary(turn: Turn): boolean {
  const status = turn.meta?.['status'];
  if (typeof status === 'string' && /^(completed|done|success|ok)$/i.test(status)) return true;
  return /\b(resolved|applied|mitigated|completed|deployed|done)\b/i.test(turn.content);
}

/** Collapse a finished sub-task's turns into one receipt line. */
export function foldReceipt(turns: Turn[]): string {
  const last = [...turns].reverse().find((t) => t.content.trim()) ?? turns[turns.length - 1];
  const gist = (last?.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
  return `Completed (${turns.length} steps): ${gist}${gist.length >= 100 ? '…' : ''}`;
}

export interface Tier1Result {
  entropy: number;
  pins: PinHit[];
  /** True when the turn was dropped from working memory as filler. */
  pruned: boolean;
}

/**
 * Run the fast path for one turn and record what it did on the tree. Pins are
 * committed (they are permanent); a pruned turn is recorded so the drop is
 * auditable. Folding spans several turns, so it is driven by the engine, not here.
 */
export function runTier1(turn: Turn, pins: RegExp[], tree: Tree, at: number): Tier1Result {
  const pinHits = findPins(turn.content, pins);
  for (const p of pinHits) {
    tree.commit({ actor: 'fastpath', op: 'pin', summary: `pinned ${p.value}`, data: { ...p }, at });
  }
  const pruned = pinHits.length === 0 && isLowSignal(turn.content);
  if (pruned) {
    tree.commit({ actor: 'fastpath', op: 'prune', summary: `pruned low-signal turn (${entropy(turn.content).toFixed(2)})`, data: { content: turn.content }, at });
  }
  return { entropy: entropy(turn.content), pins: pinHits, pruned };
}
