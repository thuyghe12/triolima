/**
 * The demo server.
 *
 * Holds the key server-side, serves the static UI, and runs one real Claude Code
 * agent (via the Claude Agent SDK) per WebSocket connection. Triolima governs it
 * from inside the harness's own hooks (see demo/agent/run.ts). The rubric the UI
 * renders is the watcher set; editing it restarts the agent session.
 *
 *   npm run demo   →   http://localhost:5173
 */
import { config as loadEnv } from 'dotenv';
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createAgent, type AgentEvent, type Judge, type Agent } from './agent/run';
import { WATCHERS, JUDGE_SYSTEM, JUDGE_CUES, type Watcher } from './agent/config';
import type { Answer, Card } from '../src/index';

loadEnv();

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env['PORT'] ?? 5173);
const apiKey = process.env['ANTHROPIC_API_KEY'];
const model = process.env['ANTHROPIC_MODEL'];
const resolvedModel = model && model.trim() ? model.trim() : 'haiku';

type OutEvent = AgentEvent | { kind: 'ready'; model: string | null } | { kind: 'policy'; items: Watcher[] };

const app = express();
app.use(express.static(path.join(here, 'web')));
const server = createServer(app);
const wss = new WebSocketServer({ server });

// A cheap, bounded tone classifier — the narrow-LLM watcher tier.
function makeJudge(key: string): Judge {
  return async (text) => {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 16, system: JUDGE_SYSTEM, messages: [{ role: 'user', content: text }] }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { content?: { type?: string; text?: string }[] };
    const t = (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('').trim();
    const m = t.match(/([a-z]+)\s+([0-9.]+)/i);
    if (m && m[1] && m[2]) return { verdict: m[1].toLowerCase(), confidence: Math.max(0, Math.min(1, parseFloat(m[2]))) };
    const w = t.split(/\s+/)[0];
    return w ? { verdict: w.toLowerCase(), confidence: 0.5 } : null;
  };
}

wss.on('connection', (ws) => {
  const send = (e: OutEvent): void => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(e)); };

  let watchers: Watcher[] = WATCHERS.map((w) => ({ ...w }));
  send({ kind: 'policy', items: watchers });
  send({ kind: 'ready', model: apiKey ? resolvedModel : null });
  if (!apiKey) {
    send({ kind: 'notice', text: 'No ANTHROPIC_API_KEY found. Add it to .env and restart with `npm run demo`. This drives a real Claude Code agent, not a mock.' });
  }

  let pending: ((a: { answer: Answer; text?: string }) => void) | null = null;
  const askHuman = (card: Card): Promise<{ answer: Answer; text?: string }> =>
    new Promise((resolve) => { pending = resolve; send({ kind: 'card', card }); });
  const judge = apiKey ? makeJudge(apiKey) : undefined;

  let agent: Agent | null = null;
  const build = (): void => {
    agent?.stop();
    agent = apiKey
      ? createAgent({ emit: send, askHuman, apiKey, model: resolvedModel, watchers, ...(judge ? { judge, judgeCues: JUDGE_CUES } : {}) })
      : null;
  };
  build();

  const clean = (w: unknown): Watcher | null => {
    if (!w || typeof w !== 'object') return null;
    const r = w as Record<string, unknown>;
    const tiers = ['code', 'decision', 'llm', 'human'];
    const actions = ['pin', 'prune', 'fold', 'extract', 'judge', 'ask'];
    if (typeof r['id'] !== 'string' || typeof r['name'] !== 'string') return null;
    if (!tiers.includes(String(r['tier'])) || !actions.includes(String(r['action']))) return null;
    return {
      id: r['id'], name: r['name'], tier: r['tier'] as Watcher['tier'], action: r['action'] as Watcher['action'],
      signal: String(r['signal'] ?? ''), owner: String(r['owner'] ?? 'you'), enabled: r['enabled'] !== false,
      threshold: typeof r['threshold'] === 'number' ? r['threshold'] : null,
      what: String(r['what'] ?? ''), how: String(r['how'] ?? ''), why: String(r['why'] ?? ''),
    };
  };

  ws.on('message', (raw) => {
    let msg: { type?: string; text?: string; answer?: Answer; watchers?: unknown[] };
    try { msg = JSON.parse(raw.toString()) as typeof msg; } catch { return; }

    if (msg.type === 'say') {
      if (!agent) { send({ kind: 'notice', text: 'Add your ANTHROPIC_API_KEY and restart to run the agent.' }); return; }
      agent.ask(String(msg.text ?? ''));
    } else if (msg.type === 'answer') {
      const resolve = pending; pending = null;
      if (resolve) resolve({ answer: (msg.answer ?? 'keep_going') as Answer, ...(msg.text ? { text: msg.text } : {}) });
    } else if (msg.type === 'rubric' && Array.isArray(msg.watchers)) {
      const next = msg.watchers.map(clean).filter((w): w is Watcher => w != null);
      if (next.length) {
        watchers = next;
        build(); // the memory config is baked at session start, so a rubric change restarts the session
        send({ kind: 'policy', items: watchers });
        send({ kind: 'notice', text: 'Rubric updated — the agent session was reset to apply it.' });
      }
    }
  });

  ws.on('close', () => { agent?.stop(); });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Triolima demo → http://localhost:${PORT}  (${apiKey ? `Claude Code agent · ${resolvedModel}` : 'no key — add ANTHROPIC_API_KEY'})`);
});
