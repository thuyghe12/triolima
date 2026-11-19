/**
 * The watchers — a rubric you own, not a scripted scenario.
 *
 * Each watcher is one scanner over the live hop stream, with a tight schema:
 *   signal     — the one thing it watches for
 *   rule/tier  — the mechanism that decides: code · decision · llm · human,
 *                chosen by how deterministic the call is and how costly a wrong
 *                one would be
 *   threshold  — when it fires
 *   action     — the one job it does on firing
 *   owner      — who owns it
 *
 * These are general rules that make sense for any conversation — not a demo.
 * The user can edit them and add their own. The engine config is derived from
 * this table, so the rubric is the single source of truth.
 */
import type { Config } from '../../src/index';

export type Tier = 'code' | 'decision' | 'llm' | 'human';
export type Action = 'pin' | 'prune' | 'fold' | 'extract' | 'judge' | 'ask';

export interface Watcher {
  id: string;
  name: string;
  /** The mechanism / rule that decides. */
  tier: Tier;
  /** The one signal it watches for. */
  signal: string;
  /** The gate it fires at (null for always-on code watchers). */
  threshold: number | null;
  /** The one job it does when it fires. */
  action: Action;
  owner: string;
  enabled: boolean;
  /** Inspect copy. */
  what: string;
  how: string;
  why: string;
}

export const WATCHERS: Watcher[] = [
  {
    id: 'identifiers', name: 'Identifiers', tier: 'code',
    signal: 'emails · URLs · IDs · amounts · dates', threshold: null, action: 'pin', owner: 'you', enabled: true,
    what: 'Hard facts: an email, a URL, a ticket id, a number, a date.',
    how: 'Regex match; pinned verbatim, never dropped.',
    why: 'A closed form with one right answer. Nothing to judge — pure code, $0, sub-ms.',
  },
  {
    id: 'filler', name: 'Filler', tier: 'code',
    signal: 'low-signal turns', threshold: 0.35, action: 'prune', owner: 'you', enabled: true,
    what: '“thanks”, “ok”, “one sec” — turns that carry no information.',
    how: 'A deterministic entropy score below a fixed floor.',
    why: 'A scalar threshold: same input, same output. No model needed.',
  },
  {
    id: 'decisions', name: 'Decisions', tier: 'decision',
    signal: 'a choice being made', threshold: 0.6, action: 'extract', owner: 'you', enabled: true,
    what: '“let’s go with…”, “we decided…”, “final answer is…”.',
    how: 'Cue coverage → a confidence score → a threshold gate.',
    why: 'A known outcome (a decision was made / not) over variable wording — a scored decision, not a fixed rule.',
  },
  {
    id: 'preferences', name: 'Preferences', tier: 'decision',
    signal: 'a stated preference', threshold: 0.55, action: 'extract', owner: 'you', enabled: true,
    what: '“I prefer…”, “always…”, “never…”, “call me…”.',
    how: 'Cue coverage → score → gate; the same engine as decisions.',
    why: 'Stable, reusable facts about the person. Known shape, variable phrasing.',
  },
  {
    id: 'tone', name: 'Tone', tier: 'llm',
    signal: 'subjective sentiment', threshold: 0.5, action: 'judge', owner: 'you', enabled: true,
    what: 'Is the person calm, pleased, frustrated, urgent?',
    how: 'A narrow LLM judges, only when the turn looks emotionally loaded.',
    why: 'Open-ended and subjective — no closed option set. Only a model can weigh it, and only when it is worth the call.',
  },
  {
    id: 'sensitive', name: 'Sensitive actions', tier: 'human',
    signal: 'delete · send · pay · publish · email', threshold: 0.5, action: 'ask', owner: 'you', enabled: true,
    what: 'Talk of an irreversible or costly action.',
    how: 'Crosses an alert gate → raises a card → you decide before it continues.',
    why: 'Critical and non-negotiable. Too costly to get wrong — it must be a person.',
  },
];

export const WATCHER_BY_ID: Record<string, Watcher> = Object.fromEntries(WATCHERS.map((w) => [w.id, w]));
/** Core rubric names → watcher id, for mapping tree commits back to a watcher. */
export const WATCHER_BY_RUBRIC: Record<string, string> = {
  'Decisions': 'decisions',
  'Preferences': 'preferences',
  'Sensitive actions': 'sensitive',
};
/** Tree op → watcher id, for the fast-path and human ops. */
export const WATCHER_BY_OP: Record<string, string> = {
  pin: 'identifiers',
  prune: 'filler',
  fold: 'identifiers',
  alert: 'sensitive',
  answer: 'sensitive',
};

/** Build the engine Config from an (editable) set of watchers. */
export function configFrom(watchers: Watcher[]): Config {
  const on = watchers.filter((w) => w.enabled);
  const rubric = (id: string, cues: string[], alert?: number) => {
    const w = on.find((x) => x.id === id);
    if (!w) return null;
    return { name: w.name, cues, threshold: w.threshold ?? 0.6, weight: w.tier === 'human' ? 2 : 1.8, ...(alert != null ? { alert } : {}) };
  };
  const rubrics = [
    rubric('decisions', ['let us go with', "let's go with", 'we decided', 'decided to', 'final', 'go with', 'agreed', 'decision is', 'i choose', 'we will use']),
    rubric('preferences', ['i prefer', 'prefer', 'always', 'never', 'call me', 'i like', 'i want', 'i need', 'my name is', 'from now on']),
    rubric('sensitive', ['delete', 'remove', 'wipe', 'erase', 'pay ', 'purchase', 'charge', 'transfer', 'publish', 'deploy', 'cancel'], 0.5),
  ].filter((r): r is NonNullable<typeof r> => r != null);
  return {
    pins: on.some((w) => w.id === 'identifiers')
      ? [/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/, /\bhttps?:\/\/\S+/, /\b[A-Z]{2,}-\d+\b/, /\$\s?[\d,]+(?:\.\d+)?/, /\b\d{4}-\d{2}-\d{2}\b/]
      : [],
    rubrics,
    budget: { hotFacts: 6, retrieveK: 4, halfLifeTurns: 12 },
  };
}

export const MEMORY_CONFIG: Config = configFrom(WATCHERS);

/** Minimal, honest system framing — the memory block is appended by the loop. */
export const SYSTEM = [
  'You are a helpful assistant with persistent memory across this conversation.',
  'The MEMORY block below is maintained for you by Triolima from everything said so far',
  '— rely on it rather than asking the person to repeat themselves. If you need something',
  'that is not in it, call recall(query) to search your deeper memory. Be natural and concise.',
].join('\n');

/** The narrow-LLM tier: a subjective tone read, only when a turn looks loaded. */
export const JUDGE_SYSTEM =
  'Classify the tone of the user message as exactly one word (calm, pleased, frustrated, urgent, anxious), then a space, then a confidence 0-1. Example: "frustrated 0.8".';

export const JUDGE_CUES = ['!', '?', 'urgent', 'asap', 'now', 'frustrat', 'angry', 'annoy', 'love', 'hate', 'please', 'wrong', 'broken', 'stupid', 'why', 'stuck', 'help'];
