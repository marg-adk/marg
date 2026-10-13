# Observability

OpenTelemetry everywhere, shipped to OpenObserve by default (open source) or any OTLP
backend. One trace per turn across processes; metrics with the GenAI semantic conventions;
structured logs that carry the trace id.

## The rule (ADR-0003)

**A feature is not done until it is visible on a panel.** A PR that adds or changes a code path
on the request side ships with:
1. a span around the new work — `withSpan("area.verb", { attrs }, fn)`; attributes under `agent.*`;
2. the failure path logged with the trace id and a stable `error.type`;
3. a metric or a behaviour event for anything countable — `counter("x_total").add(1, labels)`,
   `histogram("x_ms", { unit: "ms", boundaries: MS_BUCKETS })`, or `behaviour("kind", attrs)`
   when the runtime stepped in on the model or a product milestone happened. Labels are
   low-cardinality (tool, step, model, route, kind, ok) — never a session id or free text;
4. a panel when someone will look (observability/openobserve/dashboards.ts; `npm run o2:bootstrap` uploads them, `npm run o2:dashboards` writes the JSON for review);
5. `npm run check:otel` still passes.

## The trace tree of a turn

```
POST /api/chat/stream                     SERVER  (gateway/telemetry.ts; X-Trace-Id header)
└─ router.classify                        (two or more domains)
└─ invoke_agent <domain>                  gen_ai.conversation.id = session id
   ├─ runtime.step.read <step>            the steps engine (pre-model)
   ├─ chat <model>                        CLIENT, per model call: tokens, cost, ttft, finish
   │  └─ llm.attempt <endpoint>           one per endpoint tried (a failover reads as two)
   ├─ execute_tool <name>                 guards' verdicts, carry, ms
   │  └─ mcp.call <name>                  CLIENT → the child's SERVER span mcp.tool <name>
   ├─ runtime.step.draw <step>            late draw / redraw
   └─ behaviour.* events                  create_refused, attested_dropped, step, carry…
```

## Metrics (prefix `agent_`, configurable)

`turns_total{domain, answered_by}`, `turn_duration_ms`, `tool_calls_total{tool, ok}`,
`tool_duration_ms`, `llm_calls_total{endpoint, outcome}`, `llm_tokens_total{kind}`,
`llm_cost_usd_total`, `llm_duration_ms`, `llm_ttft_ms`, `llm_failovers_total`,
`llm_retries_total`, `llm_circuit_opened_total`, `llm_unavailable_total`,
`llm_endpoint_open` (gauge), `behaviour_events_total{kind, step, type}`, `decisions_total{backend}`,
`completions_total`, `rate_limited_total`, `usage_capped_total`, `http_requests_total`,
`http_duration_ms`, `sessions_active`, `store_duration_ms`, `stt_requests_total`,
`stt_seconds_total`, `process_*`; plus `gen_ai_client_token_usage` and
`gen_ai_client_operation_duration` for backends' AI views.

## Logs

JSON lines, one per event, written off the main thread (a worker batches writes; stdout is
synchronous under Docker). Levels via `LOG_LEVEL`; a daily file under `AGENT_LOG_DIR` kept
`AGENT_LOG_RETENTION_DAYS`; shipped to the OpenObserve logs stream when configured. Trace
lines (`AGENT_TRACE` ≠ off) reconstruct a chat from the log alone: `turn.start`, `llm.call`,
`tool.call`, `turn.done`, `turn.error`, `step`, `mcp.tool` (from inside the child) — grep one
session id for the whole story. Secrets and phone-like numbers are masked.

## Content on spans

`AGENT_OTEL_CAPTURE_CONTENT`: `heads` (default — redacted 300-character heads of the user
message, the reply, the system prompt and tool results), `full` (local debugging), `off`.
Private user text (notes) must never sit in a label or a step event; search the telemetry for
a sentinel after building a private path.

## Setup

```bash
docker compose -f observability/docker-compose.yml up -d     # OpenObserve on :5080
# .env
AGENT_O2_URL=http://localhost:5080  AGENT_O2_USER=root@example.com  AGENT_O2_PASSWORD=…
npm run o2:bootstrap                                           # streams, folder, dashboards, alerts
```
Gotchas learned: use protobuf exporters (OTLP/JSON rejects non-zero doubles on OpenObserve);
custom attributes are stored as strings (cast in panel SQL); a field exists only after a span
carried it (always emit the attributes panels filter on; prime counters at startup); the image
is distroless (no compose healthcheck — poll `/healthz`).
