# Architecture

## Layers

```
┌─ clients ──────────────────────────────────────────────────────────────────────┐
│ widget.js (web, one <script>)  ·  your app (web view / native, docs/SDK-AUTH)   │
│ HTTPS + SSE · the client protocol (docs/CLIENT-PROTOCOL.md)                      │
└───────────────┬────────────────────────────────────────────────────────────────┘
                ▼
┌─ packages/gateway ──────────────────────────────────────────────────────────────┐
│ middleware: otel → cors → headers → gateway key → json → login (verified)        │
│ per turn:   shape+owner → rate limit → usage cap → ROUTE → run → meter → nudge   │
│ super agent (router.ts): one domain per turn — a Verdict choice over domain      │
│   cards: keywords → decision model → LLM; sticky; single-domain shortcut         │
│ media (upload ≠ attach) · voice (STT) · nudges (SSE) · health · metrics          │
└───────────────┬────────────────────────────────────────────────────────────────┘
                ▼ runDomainAgent(domain, session, message)
┌─ packages/core ─────────────────────────────────────────────────────────────────┐
│ steps engine (pre-model): open ask? read in code → settle → chain → summary      │
│ prompt = identity + security preamble + capabilities + shared skills             │
│          + domain skills (typed: core + in-play type) + runtime facts            │
│ tool loop (≤ N rounds): set_type · guards (create gate, attested lists) · carry  │
│          → MCP call → draft (preview) · completion                               │
│ steps engine (post-model): late draw · summary card · redraw · dedupe · sanitize │
│ sessions · stores · trimming · llm chain · otel · logs                           │
└───────────────┬────────────────────────────────────────────────────────────────┘
                ▼ stdio MCP, token + trace context in _meta
┌─ domains/<name> (your code) ────────────────────────────────────────────────────┐
│ domain.json · skills/*.md · mcp/server.ts (validate/preview/create + internal_*) │
│ schema/*.json · steps/index.ts · mock/policy.ts · probe/ · evals/                │
└─────────────────────────────────────────────────────────────────────────────────┘
      ▲                                   ▲
      │ @marg-adk/verdict (typed decisions)   │ model chain: anthropic | openai-compatible | mock
```

## One turn, in order

1. **Gate.** Shape and length; the session resolves (hydrated on a miss) and the caller must own
   it (404 otherwise); a finished chat is 409 unless post-create edits are allowed; rate limits
   (per session, per IP, in-flight); usage caps (plan tokens → a 429 with the reset). All before
   any SSE header is written.
2. **Route.** One domain, no re-classification mid-journey or after completion.
3. **Steps first.** If a runtime ask is open, the reply is read in code: settle (the draft is
   written, the next owed step or the summary is drawn in the same reply), skip, redraw, or
   words (the model answers with a runtime fact; the ask is drawn again under its answer). If
   the summary is up, "Change something" opens the review. A runtime turn costs no model call.
4. **The model.** System prompt (cached prefix) + the runtime facts for this turn (step notes,
   media note, the open-ask note) + history + the new message; tools for the in-play type.
5. **Tools.** Each call: the runtime's own `set_type`; `internal_*` refused; the attested-list
   guard; the carry rule (settled step values override the model's); the create gate (summary
   shown for THIS draft + a whole-content yes); the MCP call with the token in `_meta`; the
   draft updated from the arguments (merge on validate, replace on preview/create); completion
   detected on `created:true` + id. Back to the model.
6. **Finalize.** Prose and ui blocks split (tolerant of fence junk); an owed step late-drawn
   under the reply with the model's own ask cut; the summary card when everything settled and
   the draft is valid; dedupe; the link scheme allowlist; the turn stored with its final blocks.
7. **After.** Metered (plan tokens into caps; the usage ledger; the metering sink), the nudge
   re-armed, pending media attached once an id exists, `done` sent with usage.

## State

- **Session** (persisted, token never): messages (windowed on turn boundaries and healed),
  usage, active domain and type, `preview` (the draft: slots, missing, refs, defaults,
  from-record, summary fingerprint, step states, edit state, identity), `shared` (media, scratch),
  completion.
- **Draft** = what the last validate/preview/create carried + runtime state. The pane and the
  summary render from it; the carry rule reads it; a change of identity resets dependent steps.
- **Step state** per key: asked (with the drawn block for reload) / settled (values, via,
  the settling message) / skipped.

## Where things run

| Concern | Where | Why |
|---|---|---|
| Who may read a session | gateway (owner check) | a session id is an id, not a credential |
| Which domain | gateway router (Verdict) | typed decision, sticky, zero-cost with one domain |
| The system prompt | core (per domain × type, cached) | identical bytes keep provider caches warm |
| Reading a reply | core readers + the step's `read` | whole-content rule, shared with evals |
| The create gate | core guard + the tool + the skill | three layers, never weakened |
| Validation | the domain's validate tool | the server may validate nothing |
| Uploads | gateway + the domain's `internal_*` tools | bytes never cross stdio as base64 |
| Counters | Redis (or memory) | atomic windows across nodes |
| Sessions, ledgers | Mongo (or files) | durable, lazily hydrated |
| Traces, metrics, logs | OTLP → OpenObserve or any backend | one trace per turn across processes |

## Entity types (variants)

A domain may declare `types` (product lines, document kinds). The prompt then carries the core
skill + only the in-play type's skill, and the tool list only that type's validate/preview/
create tools (plus common tools). The type is set from the opener's words, restored from the
draft on resume, or by the model through the runtime-provided `set_type` tool; a switch resets
the draft the way a form resets. Each type lists its own `steps` order and flags.
