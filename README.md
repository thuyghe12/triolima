# Triolima

**Memory for AI agents that remembers by meaning, not age.**

A standard context window forgets by age. When it fills, it drops the oldest
messages — message #2, which held a contract rule or an incident ID, goes so
that message #18 ("thanks, got it!") can stay. Triolima keeps what *matters*:
hard facts pinned by pattern, finished tasks folded to a one-line receipt,
filler pruned, and business signals extracted by rubric. Then it discloses only
what this turn needs, so the prompt stays small no matter how long the
conversation runs.

> Three tiers over one git-native audit tree. Every fact Triolima keeps carries
> the rubric, the confidence and the source turn that put it there — so you can
> always answer *why does the agent remember this?*

The name is the shape: **tri** tiers, in the Teolima lineage.

## Proof

One 120-turn incident conversation, critical facts planted at turn 1, replayed
through three strategies and measured the same way — tokens sent per turn, and
whether those facts are still recalled at the end (`npm run bench`):

| strategy | avg tokens / turn | final tokens | critical recall |
|---|---:|---:|---:|
| naive — full history | 830 | 1,626 | 100% (but unbounded) |
| naive — sliding window (12) | 156 | 155 | **0%** (amnesia) |
| **Triolima** | **140** | **178** | **100%** |

Triolima costs less per turn than even the sliding window, and recalls every
fact the window has already dropped. The claim is asserted in CI, so the numbers
cannot quietly rot.

## Why

Two problems, one cause — treating every token as equally important and ordered
only by time:

- **Amnesia.** The fact you needed was evicted for being old, not for being
  unimportant.
- **Bloat.** 30–40% of a window is polite filler and retry loops, and cost grows
  with every turn.

Triolima scores relevance cheaply and continuously, and keeps the prompt bounded
— target: under ~1k memory tokens per turn even after thousands of turns.

## The three tiers

```
          a turn arrives
               │
   ┌───────────▼─────────────┐   Tier 1 — synchronous, deterministic, <2ms, $0
   │ pin hard facts (regex)   │   never dropped, never summarised away
   │ fold finished tasks      │   8 tool calls → one receipt the moment it ends
   │ prune low-signal turns   │   a zero-LLM entropy score drops filler first
   └───────────┬─────────────┘
               │  (off the hot path, at a task boundary)
   ┌───────────▼─────────────┐   Tier 2 — asynchronous rubric extraction
   │ score against rubrics    │   business meaning, not just patterns
   │ gate on a threshold      │   above it → a fact in verified state,
   │                          │   tagged with rubric + confidence + source turn
   └───────────┬─────────────┘
               │
   ┌───────────▼─────────────┐   Disclosure — inject just enough
   │ L1 hot header (capped)   │   top facts by utility-weighted decay
   │ L2 retrieval (per turn)  │   hybrid search, top-k, filtered
   │ L3 deep archive (tools)  │   everything else, fetched only on demand
   └──────────────────────────┘
```

Ranking in the hot header is explicit, not a black box:

```
score = (rubric_confidence × business_weight) × e^(−ln2 / half_life × turns_since_used)
```

Use a fact and its clock resets; leave it and it fades out of the header without
being deleted.

## The git-native audit tree

Every memory operation — a pin, a fold, an extraction, a human answer — is a
commit by an *actor* (`agent`, `pin`, `rubric`, `ranker`, `human`) on one
content-addressed tree. The result is an audit DAG: `git log` tells you exactly
what was remembered, when, by which worker, and why. Black-box summarisation
can't give you that.

## Human in the loop

When a signal crosses its threshold, the loop pauses and raises one card —
**keep going · pause · correct** — then resumes on your answer. Same scores the
memory already computes, a thin hook on top: so the system that decides what to
*remember* is the same one that decides when to *ask*.

## Quickstart

```bash
npm install
npm test
npm run bench
```

`npm test` runs the full suite (including the benchmark claim); `npm run bench`
prints the comparison table above.

```ts
import { createMemory } from "triolima";

const memory = createMemory({
  pins:    [/INC-\d+/, /USD\s?[\d,]+/],
  rubrics: [
    { name: "root cause", cues: ["root cause", "traced to"], threshold: 0.8 },
    { name: "security risk", cues: ["secret", "leaked", "exposed"], threshold: 0.75, alert: 0.75 },
  ],
  budget:  { hotFacts: 8, retrieveK: 4, halfLifeTurns: 6 },
});

memory.observe(turn);                        // Tier 1: synchronous — pin, prune
const { cards } = await memory.consolidate(); // Tier 2: extract; may raise a card
const ctx = await memory.assemble(query);     // disclosure → a bounded prompt
//   ctx.header · ctx.retrieved · ctx.tokens · ctx.trace

if (cards.length) {                           // human in the loop, when it matters
  const { text } = memory.answer(cards[0].print, "correct", "do X instead");
}
```

Wrapping an existing agent loop is a few lines. The whole audit trail is
`memory.tree.log()` — every pin, fold, extraction and answer, by actor.

## Try the live demo

A **real Claude Code agent** — driven by the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk),
an empty thread, you talk, it answers — governed by Triolima from inside the
harness's own hooks, on-device. Dual panel: left the chat, right (collapsible) a
**live, per-hop trace** of the real Claude Code lifecycle — `input`, every watcher
that acts, `recall`, `output`, and the real `model.response` (actual tokens,
latency and cost). Nothing is scripted and there is no scenario.

How Triolima plugs in (no OTLP relay, no settings wiring — it's all in-process):

- **`UserPromptSubmit` hook** → runs the watchdogs and **injects the governed
  memory** into the agent's context as `additionalContext`. This is how a memory
  layer feeds a harness it doesn't own.
- **`PreToolUse` / `PostToolUse` hooks** → observe the tool hops, run the watchdogs.
- **`canUseTool`** → the permission gate (keeps it a chat + `recall` agent).
- **the SDK message stream** → real assistant text and real `usage` / `total_cost_usd`.

Every signal is a watcher, routed to the cheapest mechanism that can be trusted
with it — and **all enabled watchers run every turn**:

- **code** — a closed option set, one right answer (regex, a threshold). $0, sub-ms.
- **decision** — a known set of outcomes over variable input: a transparent scored gate.
- **llm** — open-ended and subjective: a narrow model, used only when the turn warrants it.
- **human** — critical and non-negotiable: it pauses and asks.

The **Rubric** tab is that policy, and it's yours to own: every watcher shows its
signal, *how* it is evaluated and *why* it sits in its tier — toggle, retune, or
**add your own**.

```bash
git clone https://github.com/thuyghe12/triolima.git
cd triolima
printf 'ANTHROPIC_API_KEY=sk-ant-your-key-here\n' > .env
npm install
npm run demo
```

Replace `sk-ant-your-key-here` with your own key first, then open
**http://localhost:5173**. `npm install` pulls the Agent SDK, which ships its own
runtime per-platform — **no separate `claude` CLI to install.** Writing `.env` by
overwriting avoids a dotenv gotcha (it reads the *first* `ANTHROPIC_API_KEY=` line).

Then just talk — e.g. *“My email is me@acme.com and I prefer the Karla font.
Remember that.”* Watch the trace: **Identifiers** pins the email (code),
**Preferences** extracts a fact (decision), the agent replies with those facts
already in its context, and `model.response` shows the real latency and cost. Say
something like *“delete my account”* and **Sensitive actions** (human) pauses the
turn for you — *keep going · pause · correct*.

- The key is read **server-side only** and never reaches the browser; use your own.
- Default model is the cheapest (`haiku`); set `ANTHROPIC_MODEL` to change it.
- Why the Agent SDK (observe + govern + inject) over a relay: [ADR 0003](docs/adr/0003-capture-is-an-adapter.md).

The memory governance each watcher runs is covered by tests on the engine directly
(no key, no subprocess), so CI stays green; the live agent integration is validated
by typecheck and a real run.

## Status

Built in clean, verifiable steps. This is where it is:

- [x] Scaffold, CI, docs and the first architecture decisions
- [x] Tier 1 — pins, task folding, entropy pruning
- [x] Tier 2 — rubric extractors and the threshold gate
- [x] Disclosure — hot ranker, hybrid retrieval, deep archive
- [x] Human-in-the-loop — threshold card, pause and resume
- [x] Benchmark — naive window vs Triolima, with numbers
- [x] Demo — a real Claude agent: chat, the live audit tree, the layers, HITL

## Docs

- [Architecture](docs/ARCHITECTURE.md) — the pieces and how they fit.
- [Decision records](docs/adr) — why the load-bearing choices were made.

## License

MIT — see [LICENSE](LICENSE).
