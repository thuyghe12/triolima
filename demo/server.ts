/**
 * The demo server.
 *
 * Holds the Anthropic key server-side (never the browser), serves the static UI,
 * and runs one live agent session per WebSocket connection. Memory, the audit
 * tree and the conversation are per-connection, so a reload starts a clean
 * incident. No key → the UI says so and nothing is mocked.
 *
 *   npm run demo   →   http://localhost:5173
 */
import { config as loadEnv } from 'dotenv';
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createSession, type LoopEvent } from './agent/loop';
import { anthropic } from './agent/provider';
import type { Answer } from '../src/index';

loadEnv();

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env['PORT'] ?? 5173);
const apiKey = process.env['ANTHROPIC_API_KEY'];
const model = process.env['ANTHROPIC_MODEL'];

const app = express();
app.use(express.static(path.join(here, 'web')));

const server = createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  const send = (e: LoopEvent | { kind: 'ready'; model: string | null }): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(e));
  };

  send({ kind: 'ready', model: apiKey ? (model && model.trim() ? model.trim() : 'claude-haiku-5-5') : null });
  if (!apiKey) {
    send({ kind: 'notice', text: 'No ANTHROPIC_API_KEY found. Copy .env.example to .env, add your key, and restart with `npm run demo`. The demo runs a real Claude agent — nothing here is mocked.' });
  }

  let pending: ((a: { answer: Answer; text?: string }) => void) | null = null;
  const provider = apiKey ? anthropic({ apiKey, ...(model ? { model } : {}) }) : null;
  const session = provider
    ? createSession({
        provider,
        emit: send,
        askHuman: (card) =>
          new Promise((resolve) => {
            pending = resolve;
            send({ kind: 'card', card });
          }),
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
  console.log(`Triolima demo → http://localhost:${PORT}  (model: ${apiKey ? model ?? 'claude-haiku-5-5' : 'no key — add ANTHROPIC_API_KEY'})`);
});
