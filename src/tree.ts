/**
 * The audit tree: an actor-attributed, append-only, content-addressed log of
 * every memory operation.
 *
 * This is the single source of truth and the trace at once. A pin, a fold, a
 * prune, an extraction, a human answer — each is one commit by a named actor,
 * carrying what happened and why. Because each id is a hash of the commit's
 * content *and its parent*, the log is a tamper-evident chain: you cannot change
 * an old entry without every later id changing, exactly like git. That is what
 * lets the system answer "why does the agent remember this?" from the record
 * alone, and what the demo renders as a live, colour-by-actor tree.
 *
 * It is pure and in-memory, with no dependency. A Node adapter can later
 * materialise the same commits into a real git repository (one commit per
 * event, actor in a trailer) without any tier knowing — the log is already
 * shaped like git's.
 */
import type { Actor } from './types';

export interface MemoryEvent {
  /** Content-addressed id: hash of parent + actor + op + summary + data + at. */
  id: string;
  /** The previous head, or null for the first commit. */
  parent: string | null;
  actor: Actor;
  /** The operation, e.g. 'pin', 'fold', 'prune', 'extract', 'rank', 'answer'. */
  op: string;
  /** One line: what happened and why, for the log and the card. */
  summary: string;
  /** Operation-specific detail. */
  data: Record<string, unknown>;
  /** Logical time — the turn number — so the tree lines up with the chat. */
  at: number;
}

export interface Tree {
  /** Append a commit by an actor; returns the stored event (with its id). */
  commit: (e: Omit<MemoryEvent, 'id' | 'parent'>) => MemoryEvent;
  /** The whole log, oldest first. */
  log: () => MemoryEvent[];
  /** The current head id, or null when empty. */
  head: () => string | null;
  /** Just one actor's commits — for colouring and audit. */
  byActor: (actor: Actor) => MemoryEvent[];
}

/**
 * A small, synchronous content hash (FNV-1a, 64-bit via two lanes → 16 hex).
 * Not cryptographic — it is a stable content address for an in-process DAG,
 * chosen because it needs no dependency and runs identically in Node and the
 * browser. A git adapter that needs real sha1 can rehash on materialisation.
 */
export function contentId(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0xc9dc5118;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ((c + i) & 0xff), 0x01000193) >>> 0;
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

export function createTree(): Tree {
  const events: MemoryEvent[] = [];

  const commit = (e: Omit<MemoryEvent, 'id' | 'parent'>): MemoryEvent => {
    const parent = events.length ? events[events.length - 1]!.id : null;
    const id = contentId(`${parent ?? ''}|${e.actor}|${e.op}|${e.summary}|${JSON.stringify(e.data)}|${e.at}`);
    const event: MemoryEvent = { id, parent, ...e };
    events.push(event);
    return event;
  };

  return {
    commit,
    log: () => events.slice(),
    head: () => (events.length ? events[events.length - 1]!.id : null),
    byActor: (actor) => events.filter((x) => x.actor === actor),
  };
}
