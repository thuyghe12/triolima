# 2. TypeScript core, browser-ready

Date: 2026-11-19

## Status

Accepted

## Context

The engine could be written in Python or TypeScript. The workload is I/O-bound —
the model call dominates — so raw language performance is not a factor. Two
things that are real factors pull in opposite directions:

- The agent/memory ecosystem (LlamaIndex, Mem0, Zep, the Azure AI SDK) is
  Python-first, which favours Python for drop-in adoption.
- A core goal is a working demo someone can **try with one click, no setup**: an
  agent chat beside the memory tiers rendering live, with a human-in-the-loop
  pause. The lowest-friction version of that runs entirely in the browser, which
  favours one language shared by the library and the demo.

## Decision

Write the core in **TypeScript**, with no runtime dependencies, so the same code
runs in Node (as a library) and in the browser (for the demo). The demo is then
zero-backend and instantly shareable, and the whole project is one language and
one mental model.

Keep every tier a pure function of turns and config, with stores and git
materialisation behind interfaces, so the architecture is language-agnostic and a
Python port is a mechanical follow-up rather than a redesign.

## Consequences

- One language for the library and the demo; the demo ships as a static app.
- No native ML-ecosystem integration on day one; that is the cost, accepted
  because the demo's reach matters more for this project's purpose.
- The pure-function boundary is now a constraint to hold: no tier may reach for
  Node-only or browser-only APIs in the core.
