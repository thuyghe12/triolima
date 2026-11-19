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

## What proves it

A benchmark replays a long conversation through a naive window and through
Triolima, and reports tokens per turn, latency, and whether a planted critical
fact is still recalled at turn *N*. The numbers, not the prose, are the claim.
