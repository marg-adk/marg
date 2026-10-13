# ADR 0006 — Metering is pass-through; users see a percentage

- **Status:** Accepted
- **Date:** 2026-09-18 → 2026-09-19 (origin)

## Context
Usage needed to be limited per user and billed per organisation. Options for the counted
unit: raw tokens (inflates a chat 14× with cached reads), billable tokens only (cost per
counted token varied 8.9×), "things created" (a job's cost varied 2.4–4.6× with how it went).

## Decision
- **Bill what vendors bill you.** Each turn produces vendor cost lines priced at the
  endpoint's rate; work served from own infrastructure costs nothing.
- **Plan tokens** (cost-weighted: input 1, cached 0.1, output 6, cache write 1 by default) are
  the unit caps count — measured r = 1.00 against cost — fixed to the primary model so a
  failover premium is never charged to the user.
- **Users see a percentage** of their cap and the reset time; never tokens, never "N left".
- The gateway keeps the counters and the ledger; a metering service (optional, fed by a
  buffered idempotent fail-open client) rates events and feeds a billing engine; the agent
  never talks to billing.
- Per-model config, including price, lives on the endpoint.

## Consequences
Ledger events carry opaque ids and enums only. Adding a vendor line (speech-to-text seconds,
a paid lookup) is one `record()` call with a deterministic event id.


---

<small>Source: <a href="https://github.com/marg-adk/marg/blob/main/docs/adr/0006-metering-pass-through.md">docs/adr/0006-metering-pass-through.md</a> — edit it there; the site mirrors the repository.</small>
