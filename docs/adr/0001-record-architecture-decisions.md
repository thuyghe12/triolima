# 1. Record architecture decisions

Date: 2026-11-19

## Status

Accepted

## Context

This project is built to be read — by an interviewer over the shoulder, then by
an engineering team taking it over, then by the public. The load-bearing choices
(language, boundaries, what is in scope) matter more than any single file, and a
commit message is too small to hold the reasoning behind them.

## Decision

Keep a lightweight log of architecture decision records (ADRs) in `docs/adr`,
one short file per decision, in the style Michael Nygard described. Each records
the context, the decision and its consequences, and is never edited once
accepted — a later decision supersedes it instead.

## Consequences

- Anyone can see *why* the project is the way it is, not just *what* it is.
- The log is append-only, so the reasoning stays honest over time.
- It costs a few minutes per real decision; trivial choices do not get one.
