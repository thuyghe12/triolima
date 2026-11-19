# Architecture

Triolima is one small engine with three tiers and one substrate. This document
is the map; the [decision records](adr) hold the *why* behind the load-bearing
choices.

## The shape

```
observe(turn) ─▶ Tier 1 (sync)  ─────────────▶ audit tree (commit, actor=pin)
                 pins · fold · prune

consolidate() ─▶ Tier 2 (async) ─────────────▶ audit tree (commit, actor=rubric)
                 rubric score → threshold gate → verified state

assemble(q)   ─▶ Disclosure ─────────────────▶ bounded prompt + trace
                 L1 hot header (ranked, capped)
                 L2 hybrid retrieval (per turn)
                 L3 deep archive (tools, on demand)

threshold hit ─▶ Human in the loop ──────────▶ pause · card · resume
```

Everything a tier does is a commit on the audit tree by a named actor, so the
whole history of a conversation's memory is one inspectable DAG.

## The pieces

| Piece | Job | Nature |
|---|---|---|
| **Tier 1** | pin hard facts, fold finished tasks, prune filler | pure, deterministic, synchronous, no model |
| **Tier 2** | score a completed slice against rubrics, gate, extract | async, off the hot path |
| **Disclosure** | assemble just enough context, bounded by the budget | pure ranking + retrieval |
| **Store** | hold pins, verified state and the archive | pluggable; in-memory by default |
| **Audit tree** | an actor-attributed, append-only event DAG | the source of truth and the trace |
| **Human-in-the-loop** | pause and ask when a signal crosses its threshold | a thin hook on Tier 2 scores |

## Boundaries

- **The core has no runtime dependencies** and no required I/O. It is a function
  of turns and config. A store is an interface; the default keeps everything in
  memory. Git materialisation and retrieval back-ends are adapters, never
  requirements.
- **The hot path never calls a model.** Tier 1 is regex, counters and a
  zero-LLM signal score, so it adds no latency to the live turn. Only Tier 2
  may be slow, and it runs after a task boundary, off that path.
- **Cost is bounded by construction.** The disclosure budget caps the header and
  the retrieval set; the archive grows without touching per-turn cost.
- **Capture is an adapter.** `observe()` is the one seam memory is fed through. An
  app that owns its loop (the [demo](../demo), over the Anthropic Messages API)
  instruments the four hops directly; an external runtime (Claude Code via OTel or
  hooks) maps its trace onto the same `Hop` vocabulary. The three tiers never know
  which. See [ADR 0003](adr/0003-capture-is-an-adapter.md).

## The demo

`demo/` is a working proof, not a mock: a real, user-led Claude agent (empty thread,
no scenario) in a dual panel — chat on the left, and on the right a **live per-hop
trace** (OTel-style spans with real durations) where each operation is **classified
by the mechanism that handled it** (code · decision · narrow-LLM · human), plus a
Rubric tab where that policy is owned, retuned and extended. The tiering is
the thesis made visible: each signal is routed to the cheapest mechanism that can
be trusted with it, escalating to a human only for the critical, non-negotiable
ones. `demo/agent/loop.ts` is the whole integration — `observe` at each hop,
`assemble` to build the prompt, `consolidate` to extract and raise the card — and
it maps each operation to its tier for the trace. The model sits behind a one-method
`ModelProvider` (and a narrow-LLM `judge`), so the loop is tested in CI with a
scripted model and runs for real with a key.

## What proves it

A benchmark replays a long conversation through a naive window and through
Triolima, and reports tokens per turn, latency, and whether a planted critical
fact is still recalled at turn *N*. The numbers, not the prose, are the claim.
