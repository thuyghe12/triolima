/**
 * The agent's world: a small SRE corpus and four real tools over it.
 *
 * Nothing here is mocked for the loop — these are the tools the live model
 * actually calls, returning real records from the corpus. `apply_mitigation`
 * is the one that changes production, so it is gated behind a human (see the
 * loop's MUTATING check).
 */
import type { ToolSpec } from './provider';

export const MUTATING = new Set(['apply_mitigation']);

interface Incident {
  id: string;
  service: string;
  severity: string;
  started: string;
  status: string;
  symptom: string;
}

const INCIDENTS: Record<string, Incident> = {
  'INC-7788': {
    id: 'INC-7788',
    service: 'payments-api',
    severity: 'SEV2',
    started: '14:02 UTC',
    status: 'open',
    symptom: 'payments-api returning 503 to checkout; connection pool exhausted, Stripe calls timing out',
  },
  'INC-7742': {
    id: 'INC-7742',
    service: 'search',
    severity: 'SEV3',
    started: '09:10 UTC',
    status: 'resolved',
    symptom: 'elevated p99 on search after an index rebuild',
  },
};

const METRICS: Record<string, Record<string, string>> = {
  'payments-api': { pool_in_use: '200/200 (saturated)', stripe_latency_p99: '2100ms', error_rate: '18%', rps: '540' },
  'search': { p99: '180ms', error_rate: '0.2%', rps: '1200' },
};

const RUNBOOKS: { title: string; body: string; tags: string[] }[] = [
  {
    title: 'Connection pool exhaustion',
    body: 'Symptoms: pool_in_use at max, 503s, upstream timeouts. Fix: raise the pool size, enable the circuit breaker on the slow upstream, and restart the service to drain stuck connections. Verify error_rate drops.',
    tags: ['connection pool', 'pool', '503', 'timeout', 'exhausted'],
  },
  {
    title: 'Stripe latency',
    body: 'When Stripe p99 exceeds 1s, enable the circuit breaker and retry with exponential backoff so checkout degrades gracefully instead of exhausting the pool.',
    tags: ['stripe', 'latency', 'circuit breaker', 'checkout'],
  },
  {
    title: 'Index rebuild p99',
    body: 'After a search index rebuild, p99 settles within 15 minutes; if not, roll back the index alias.',
    tags: ['search', 'index', 'p99'],
  },
];

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'get_incident',
    description: 'Look up an incident by id, e.g. INC-7788. Returns service, severity, start time, status and the reported symptom.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    strict: true,
  },
  {
    name: 'get_metrics',
    description: 'Current metrics for a service, e.g. payments-api.',
    input_schema: { type: 'object', properties: { service: { type: 'string' } }, required: ['service'], additionalProperties: false },
    strict: true,
  },
  {
    name: 'search_runbooks',
    description: 'Search the runbook library for operational guidance.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
    strict: true,
  },
  {
    name: 'apply_mitigation',
    description: 'Apply a mitigation action to a service. This changes production and may require human approval.',
    input_schema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'], additionalProperties: false },
    strict: true,
  },
];

export function executeTool(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'get_incident': {
      const inc = INCIDENTS[String(input['id'] ?? '').toUpperCase()];
      return inc ? JSON.stringify(inc) : `No incident ${String(input['id'])}`;
    }
    case 'get_metrics': {
      const m = METRICS[String(input['service'] ?? '')];
      return m ? JSON.stringify(m) : `No metrics for ${String(input['service'])}`;
    }
    case 'search_runbooks': {
      const q = String(input['query'] ?? '').toLowerCase();
      const first = q.split(/\s+/)[0] ?? '';
      const hits = RUNBOOKS.filter(
        (r) => r.title.toLowerCase().includes(q) || r.tags.some((t) => q.includes(t) || (first.length > 2 && t.includes(first))),
      );
      const list = (hits.length ? hits : RUNBOOKS).slice(0, 2).map((r) => ({ title: r.title, body: r.body }));
      return JSON.stringify(list);
    }
    case 'apply_mitigation':
      return `Applied: ${String(input['action'] ?? '')}. error_rate now 1.2%, pool_in_use 120/400. INC-7788 mitigated.`;
    default:
      return `Unknown tool ${name}`;
  }
}
