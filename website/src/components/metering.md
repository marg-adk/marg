# Metering and cost

## The principle: bill what vendors bill you

Metering is pass-through cost attribution, not a token-count product. A turn produces vendor
cost lines — LLM tokens by bucket per model, speech-to-text seconds, paid lookups — each priced
at the endpoint's own rate (`LLM_<NAME>_PRICE`, `AGENT_STT_PRICE_PER_MIN`). Work served from
your own infrastructure costs nothing and is recorded as such: a prompt-cache hit is billed
at the provider's cache-read rate because the provider bills it; a runtime-answered turn (no
model call) is free; a semantic cache you built yourself is free.

## The unit users see: a percentage

Users never see tokens, and never "N things left" (a job's cost varies 2–5× with how it goes).
Caps count **plan tokens** — a cost-weighted token count (fresh input 1, cached read 0.1,
output 6, cache write 1 by default: a typical primary model's price ratios) — because measured
on real chats it tracks the bill with r = 1.00 where raw totals varied 2.4× and billable-only
counts 8.9×. The widget shows "Daily · 33% used · resets in 24h". Weights are environment
(`AGENT_PLAN_WEIGHT_*`), fixed to the primary model so a failover premium is never charged to
the user.

## Where the numbers live

- **Per call**: the chain tags each model reply with provider, model and USD cost (price table
  or override); the `chat` span carries `gen_ai.usage.*` and `gen_ai.usage.cost`.
- **Per session**: `session.usage` (four buckets, calls, turns, cost_usd, last provider/model).
- **Per turn**: `usage_events` ledger (Mongo or JSONL under `.data/ledger/`): tokens, plan
  tokens, cost, provider, model, tool calls, whether the runtime answered.
- **Caps**: Redis fixed windows (5h / day / week) + a calendar month per subject (the verified
  user id hashed, else the session) — `usage-caps.ts`.
- **A metering service** (optional): `AGENT_METERING_URL` makes the gateway POST batched
  events through `@marg-adk/metering` — buffered, idempotent (`event_id = session:turn:kind`),
  fail-open; `check(account)` on the hot path bounded to 300 ms. The service rates events
  against a catalogue, keeps a durable ledger, and feeds a billing engine (plans, wallets,
  invoices) — e.g. Lago (AGPL, self-hosted) — never the agent.

## Rules for emitters

- No PII, no content in events — opaque ids and enums only; events are retained for years.
- A deterministic `event_id` wherever your code may retry.
- Omit `vendor_cost` when no third party charged for the work.
- One event per token bucket per model call when you need per-model invoices; one per turn
  when a blended rate is enough.

## Cost levers, in order of effect

1. The cached prefix dominates: keep the system prompt byte-identical per domain × type.
2. Load only the in-play variant's skills and tools (the typed prompt): −56% prompt size.
3. A typed decision instead of a model call wherever a decision will do (routing, readers).
4. Runtime-owned steps: a tap read in code costs no tokens at all.
5. Two-stage tool-output trimming; tool results re-fetched on demand.
6. Compare models on blended ₹/$ per million under YOUR prefix profile, never list price.


---

<small>Source: <a href="https://github.com/marg-adk/marg/blob/main/docs/METERING.md">docs/METERING.md</a> — edit it there; the site mirrors the repository.</small>
