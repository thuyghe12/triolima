/**
 * How Triolima is configured for the incident agent, and the agent's own system
 * prompt. The pins and rubrics are the whole policy: what to lock verbatim, what
 * business signals to extract, and which of those should pause for a human.
 */
import type { Config } from '../../src/index';

export const MEMORY_CONFIG: Config = {
  // Hard facts, pinned verbatim and never dropped.
  pins: [/INC-\d+/, /\bpayments-api\b/i, /\bconnection pool\b/i, /USD\s?[\d,]+/],
  rubrics: [
    { name: 'root cause', cues: ['root cause', 'traced to', 'caused by', 'because', 'due to', 'exhausted', 'saturated'], threshold: 0.6, weight: 2.5 },
    { name: 'mitigation', cues: ['mitigation', 'circuit breaker', 'raise pool', 'backoff', 'scale', 'enable'], threshold: 0.55, weight: 1.8 },
    // Crosses its alert gate on extraction, so an irreversible step pauses for a human.
    { name: 'irreversible action', cues: ['restart', 'failover', 'rollback', 'delete'], threshold: 0.5, weight: 2, alert: 0.5 },
  ],
  budget: { hotFacts: 6, retrieveK: 4, halfLifeTurns: 10 },
};

export const SYSTEM = [
  'You are an on-call SRE incident assistant. Investigate incidents with the tools:',
  'get_incident, get_metrics and search_runbooks to diagnose, then apply_mitigation to act.',
  '',
  'The MEMORY block below is your working memory, maintained by Triolima. It holds',
  'what matters from the incident so far — you are NOT shown the full transcript, so',
  'rely on it. Be concise and concrete. When you have identified a root cause and the',
  'right mitigation, call apply_mitigation; a human may be asked to approve before it runs.',
].join('\n');
