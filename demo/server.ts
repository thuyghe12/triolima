/**
 * The demo server.
 *
 * Holds the Anthropic key server-side (never the browser), serves the static UI,
 * and runs one live agent session per WebSocket connection. On connect it sends
 * the policy (the four-tier rubric the UI renders and the user owns). The narrow-
 * LLM tier is a real, bounded model call wired here as the session's `judge`.
 *
 *   npm run demo   →   http://localhost:5173
 */
import { config as loadEnv } from 'dotenv';
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createSession, type LoopEvent, type Judge } from './agent/loop';
import { anthropic } from './agent/provider';
import { POLICY, JUDGE_SYSTEM, JUDGE_CUES } from './agent/config';
import type { Answer } from '../src/index';

loadEnv();

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env['PORT'] ?? 5173);
const apiKey = process.env['ANTHROPIC_API_KEY'];
const model = process.env['ANTHROPIC_MODEL'];
const resolvedModel = model && model.trim() ? model.trim() : 'claude-haiku-5-5';

type OutEvent = LoopEvent | { kind: 'ready'; model: string | null } | { kind: 'policy'; items: typeof POLICY };

const app = express();
app.use(express.static(path.join(here, 'web')));

const server = createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  const send = (e: OutEvent): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(e));
  };

  send({ kind: 'policy', items: POLICY });
  send({ kind: 'ready', model: apiKey ? resolvedModel : null });
  if (!apiKey) {
    send({ kind: 'notice', text: 'No ANTHROPIC_API_KEY found. Copy .env.example to .env, add your key, and restart with `npm run demo`. The demo runs a real Claude agent — nothing here is mocked.' });
  }

  let pending: ((a: { answer: Answer; text?: string }) => void) | null = null;
  const provider = apiKey ? anthropic({ apiKey, ...(model ? { model } : {}) }) : null;

  const judge: Judge | undefined = provider
    ? async (text) => {
        const c = await provider.complete(JUDGE_SYSTEM, [{ role: 'user', content: text }], []);
        const m = c.text.trim().match(/([a-z]+)\s+([0-9.]+)/i);
        if (m && m[1] && m[2]) return { verdict: m[1].toLowerCase(), confidence: Math.max(0, Math.min(1, parseFloat(m[2]))) };
        const word = c.text.trim().split(/\s+/)[0];
        return word ? { verdict: word.toLowerCase(), confidence: 0.5 } : null;
      }
    : undefined;

  const session = provider
    ? createSession({
        provider,
        emit: send,
        askHuman: (card) => new Promise((resolve) => { pending = resolve; send({ kind: 'card', card }); }),
        ...(judge ? { judge, judgeCues: JUDGE_CUES } : {}),
      })
    : null;

  ws.on('message', (raw) => {
    let msg: { type?: string; text?: string; answer?: Answer };
    try {
      msg = JSON.parse(raw.toString()) as typeof msg;
    } catch {
      return;
    }
    if (msg.type === 'say') {
      if (!session) {
        send({ kind: 'notice', text: 'Add your ANTHROPIC_API_KEY and restart to run the agent.' });
        return;
      }
      void session.say(String(msg.text ?? '')).catch((err: unknown) =>
        send({ kind: 'error', message: err instanceof Error ? err.message : String(err) }),
      );
    } else if (msg.type === 'answer') {
      const resolve = pending;
      pending = null;
      if (resolve) resolve({ answer: (msg.answer ?? 'keep_going') as Answer, ...(msg.text ? { text: msg.text } : {}) });
    }
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Triolima demo → http://localhost:${PORT}  (${apiKey ? `model: ${resolvedModel}` : 'no key — add ANTHROPIC_API_KEY'})`);
});
