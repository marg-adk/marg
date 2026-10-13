# ADR 0003 — OpenTelemetry everywhere; a feature is done when it is visible

- **Status:** Accepted
- **Date:** 2026-09-28 (origin)

## Context
Three engineering roles must be served from panels alone: improving the system (latency and
cost per turn, round, model, tool), fixing a failed journey (one session's story with the
trace id from the error), raising a concern (alerts). Logs alone did not serve the first two.

## Decision
- Traces (OpenTelemetry GenAI semantic conventions: `invoke_agent` → `chat` → `execute_tool`
  → `mcp.tool` → backend), metrics (`agent_*` + `gen_ai_client_*`) and logs (shipped with the
  trace id) go to an OTLP backend; OpenObserve (open source) by default, over protobuf.
- The trace context crosses the MCP boundary in `_meta` so the tool server's spans join the
  gateway's trace.
- **Standing rule:** every new code path on the request side ships with a span, a logged
  failure path carrying the trace id, a counter/histogram or `behaviour()` event, and a panel
  when someone will look. `check:otel` guards the seam.
- Content on spans is heads-only and redacted by default; labels carry counts and enums only.
- No auto-instrumentation loader (unreliable under an ESM runner); fetch is captured through
  undici's diagnostics channel; everything else is an explicit span.

## Consequences
Without an endpoint configured every call is a no-op (dev and CI need no service). Panel SQL
casts custom attributes (stored as strings); attributes panels filter on are always emitted;
counters are primed at startup so alerts can be saved before the first incident.


---

<small>Source: <a href="https://github.com/marg-adk/marg/blob/main/docs/adr/0003-observability.md">docs/adr/0003-observability.md</a> — edit it there; the site mirrors the repository.</small>
