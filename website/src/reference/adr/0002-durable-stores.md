# ADR 0002 — Durable stores with graceful fallback

- **Status:** Accepted
- **Date:** 2026-08-09 (origin)

## Context
Rate limits, usage caps, sessions and the usage ledger lived in process memory. In a
multi-node deploy, in-memory limits silently multiply by node count (a correctness bug, not a
nicety), sessions created on one node 410 on another, and billing needs a durable ledger.

## Decision
- **Redis** (`AGENT_REDIS_URL`) for atomic fixed-window counters: INCRBY + PEXPIRE NX gives a
  window that starts at first use and resets when it expires, correct across nodes. Used by
  rate limits and usage caps.
- **MongoDB** (`AGENT_MONGO_URL`) for sessions (lazily hydrated, never bulk-loaded), the
  `usage_events` ledger and the `events` product ledger.
- **Unset or unreachable ⇒ in-memory counters, file sessions, JSONL ledgers**, with a warning —
  a laptop and CI need no services. `/api/health` shows which backend is live.
- Deliberately process-local even with Redis: in-flight guards (one turn per session, a global
  cap) and per-node metrics — sticky sessions are the recommendation.
- Ledger writes are fire-and-forget: an outage loses ledger events, never blocks a chat.
- node-redis reconnects forever: the initial connect is bounded (4 s) or startup hangs.

## Consequences
New shared counters go through `getCounterStore()`; never a process-local Map for anything
that must be shared. Multi-node deployments set both URLs; the checklist says so.


---

<small>Source: <a href="https://github.com/marg-adk/marg/blob/main/docs/adr/0002-durable-stores.md">docs/adr/0002-durable-stores.md</a> — edit it there; the site mirrors the repository.</small>
