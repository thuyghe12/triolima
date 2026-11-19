# 3. Capture is an adapter; the demo owns the loop

Date: 2026-11-19

## Status

Accepted.

## Context

Memory has to be fed from *somewhere*: the agent's turns, tool calls and results
have to reach `observe()`. There are two ways to capture them.

1. **Own the loop.** When we write the agent loop ourselves — as the demo does,
   over the Anthropic Messages API — we call `observe()` directly at each hop
   (input, tool_call, tool_result, output). Nothing is inferred; capture is
   complete and synchronous.
2. **Adapt an external runtime.** When the loop belongs to someone else (Claude
   Code, another framework), we cannot insert calls into it. We instead consume
   what it emits — OpenTelemetry spans, or process hooks — and map those onto the
   same four hops.

A natural question, given the earlier Teolima work used OpenTelemetry: should the
core depend on OTel? And does an Anthropic API key give us OTel to work with?

It does not. OpenTelemetry tracing in the earlier work came from *Claude Code the
harness* emitting spans — not from the model API. An Anthropic key is a key to
the Messages API; it carries no tracing channel. So for an app that owns its loop,
there is nothing to consume: you simply instrument the hops you already control.

## Decision

`observe()` is the capture seam, and capture is an **adapter**, never part of the
core.

- The core library and the demo **own the loop** and instrument the four hops
  directly. This is the simplest and most complete path, and it is what ships.
- OTel / hooks ingestion is an **optional adapter** for external runtimes, mapping
  spans or hook events onto the same `Turn` + `Hop` vocabulary. It is documented
  here as the extension point; no code depends on it, and the core stays
  zero-dependency and isomorphic.

The `Hop` type (`input | tool_call | tool_result | output`) is deliberately the
intersection of what an owned loop can emit and what an external runtime's trace
exposes, so both adapters produce the same shape.

## Consequences

- The demo is honest: a real agent, real tools, real model calls, with capture
  wired in four lines — no tracing backend to stand up on the interviewer's
  laptop.
- Pointing Triolima at an external runtime later is an adapter, not a rewrite:
  translate its events to `Turn`s and the three tiers are unchanged.
- We take no dependency on OpenTelemetry in the core, and make no claim that an
  API key provides tracing — because it doesn't.
