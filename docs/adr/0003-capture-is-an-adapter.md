# 3. Capture is an adapter; the demo governs a real agent via the Agent SDK

Date: 2026-11-19

## Status

Accepted. (Supersedes the earlier framing of this ADR, which assumed the demo
owned its own Messages-API loop.)

## Context

Memory has to be fed from *somewhere*, and its decisions have to be *applied*
somewhere. For the demo we want a **real** agent, **real** per-hop tracing, and
Triolima actually governing it — injecting memory, running the watchdogs, pausing
for a human — not a mock.

Three ways to get there were on the table:

1. **Own the loop (Messages API).** We write the agent loop and call `observe()`
   at each hop directly. Full control, but the "agent" is our own thin loop, and
   the trace is only what we instrument — not a real harness's lifecycle.
2. **Observe a vanilla Claude Code agent over OTLP.** Wire Claude Code's native
   telemetry to a local relay (the approach the Teolima work used). Real hops, on
   device — but observe-only: we cannot inject governed memory into Claude Code's
   context, which is the whole point of a *memory* product.
3. **Drive Claude Code as a library (the Claude Agent SDK).** We don't own the
   loop; the harness does. But its in-process hooks let us do everything at once.

## Decision

The demo uses the **Claude Agent SDK**. Capture — and injection, and governance —
is an **adapter** onto the harness's own instrumentation, in-process, on-device:

- **`UserPromptSubmit` hook** runs the watchdogs and returns the Triolima memory
  block as `additionalContext` — the injection seam. A memory layer feeds a
  harness it does not own without touching the harness's code.
- **`PreToolUse` / `PostToolUse` hooks** observe the tool hops and run the watchdogs.
- **`canUseTool`** is the permission gate; hooks are async, so a human-in-the-loop
  card can `await` a person's answer *mid-turn* and genuinely pause the real agent.
- **The SDK message stream** gives real assistant text and real `usage` /
  `total_cost_usd` / `duration_api_ms`, so the trace shows real tokens, latency and
  cost — no fabricated spans.

The core memory engine stays model-free and zero-dependency; the Agent SDK and the
hooks live only in `demo/`.

## Consequences

- The demo is honest: a real Claude Code agent, real hops, real cost — and
  Triolima provably governs it (injects memory, extracts, pauses).
- `npm install` pulls the Agent SDK, which ships a per-platform runtime, so there
  is no separate `claude` CLI to install — it runs with `npm run demo` and a key.
- Capture/injection is an adapter: the same three tiers (code · decision · llm ·
  human) could later be pointed at a different runtime by writing new hook
  adapters, without changing the engine.
- The memory config is baked at session start, so editing the rubric restarts the
  agent session — a known limitation of this adapter, fixable later.
