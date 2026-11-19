/**
 * The policy — and it IS the product.
 *
 * Every signal the agent produces is handled by the *cheapest sufficient
 * mechanism*, chosen by two axes: how deterministic the decision is, and how
 * costly a wrong call would be. That gives four tiers:
 *
 *   code     — a closed option set with one right answer. Regex / a scalar
 *              threshold. $0, sub-millisecond, always the same.
 *   decision — a known set of outcomes over semantically variable input. A
 *              transparent scored gate: structured, explainable, model-free.
 *   llm      — open-ended, subjective, no closed option set. A narrow model,
 *              used only as a fallback when the cheaper tiers are ambiguous.
 *   human    — critical and non-negotiable. The cost of being wrong is too high
 *              to automate; it pauses and asks a person.
 *
 * The user owns this table. The UI renders it, shows how each item is evaluated
 * and when it fired, and the trace tags every live event with its tier.
 */
import type { Config } from '../../src/index';

export type Tier = 'code' | 'decision' | 'llm' | 'human';

export interface PolicyItem {
  id: string;
  name: string;
  tier: Tier;
  /** What it watches for. */
  what: string;
  /** How it is evaluated — the mechanism, in one line. */
  how: string;
  /** Why it sits in this tier — the risk / determinism rationale. */
  why: string;
}

export const POLICY: PolicyItem[] = [
  {
    id: 'pins', name: 'Hard facts', tier: 'code',
    what: 'Incident IDs, service names, amounts.',
    how: 'Regex match; pinned verbatim, never dropped.',
    why: 'A closed set with one right answer. Nothing to judge — pure code, $0, sub-ms.',
  },
  {
    id: 'prune', name: 'Filler pruning', tier: 'code',
    what: 'Low-signal turns — “thanks”, “one sec”.',
    how: 'A deterministic entropy score below a fixed floor.',
    why: 'A scalar threshold: same input, same output. No model needed.',
  },
  {
    id: 'fold', name: 'Task folding', tier: 'code',
    what: 'A finished sub-task — a tool sequence that completed.',
    how: 'Boundary detection, then collapse to one receipt line.',
    why: 'Structural and deterministic — read from the hop, not its meaning.',
  },
  {
    id: 'Root cause', name: 'Root cause', tier: 'decision',
    what: 'The stated cause of the incident.',
    how: 'Cue coverage → a confidence score → a threshold gate.',
    why: 'A known outcome (cause / not) over variable wording. Structured, so a scored decision — not a fixed rule, not yet a model.',
  },
  {
    id: 'Mitigation', name: 'Mitigation', tier: 'decision',
    what: 'The proposed fix — breaker, pool size, backoff.',
    how: 'Cue coverage → score → gate; the same engine as root cause.',
    why: 'Known shape, variable phrasing. A decision over semantics.',
  },
  {
    id: 'Blast radius', name: 'Blast radius', tier: 'llm',
    what: 'How bad is this, really — the subjective severity call.',
    how: 'A narrow LLM judges, only when the cheaper tiers are ambiguous.',
    why: 'Open-ended, no closed option set. Only a model (or a person) can weigh it — the expensive tier, used as a fallback.',
  },
  {
    id: 'Irreversible action', name: 'Irreversible action', tier: 'human',
    what: 'restart · failover · rollback · delete.',
    how: 'Crosses an alert gate → raises a card → a person decides.',
    why: 'Critical and non-negotiable. Too costly to get wrong — it must be human.',
  },
];

export const TIER_BY_ITEM: Record<string, Tier> = Object.fromEntries(POLICY.map((p) => [p.name, p.tier]));

// The engine config is derived from the policy: code items are pins + the
// deterministic fast path; decision + human items are rubrics; the llm item is
// handled by the loop's judge, off the core (which stays model-free).
export const MEMORY_CONFIG: Config = {
  pins: [/INC-\d+/, /\bpayments-api\b/i, /\bconnection pool\b/i, /USD\s?[\d,]+/],
  rubrics: [
    { name: 'Root cause', cues: ['root cause', 'traced to', 'caused by', 'because', 'due to', 'exhausted', 'saturated'], threshold: 0.6, weight: 2.5 },
    { name: 'Mitigation', cues: ['mitigation', 'circuit breaker', 'raise pool', 'backoff', 'scale', 'enable'], threshold: 0.55, weight: 1.8 },
    { name: 'Irreversible action', cues: ['restart', 'failover', 'rollback', 'delete'], threshold: 0.5, weight: 2, alert: 0.5 },
  ],
  budget: { hotFacts: 6, retrieveK: 4, halfLifeTurns: 10 },
};

export const SYSTEM = [
  'You are an on-call SRE incident assistant. Investigate incidents with the tools:',
  'get_incident, get_metrics and search_runbooks to diagnose, then apply_mitigation to act.',
  '',
  'The MEMORY block below is your working memory, maintained by Triolima. It holds',
  'what matters from the incident so far — you are NOT shown the full transcript, so',
  'rely on it. Be concise and concrete. When you have a root cause and the right',
  'mitigation, call apply_mitigation; a human may be asked to approve before it runs.',
].join('\n');

/** The narrow-LLM tier: a subjective severity call, used only as a fallback. */
export const JUDGE_SYSTEM =
  'You are a severity judge for an SRE incident. Given the latest update, classify the blast radius as one of: contained, elevated, severe. Answer with exactly one word, then a space, then a confidence 0-1. Example: "severe 0.8".';

export const JUDGE_CUES = ['root cause', 'caused', 'because', 'due to', 'exhausted', 'impact', 'checkout', 'customers', '503', 'outage'];
