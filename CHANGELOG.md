# Changelog

## 0.1.0 — 2026-10-13

First open-source release, extracted and generalised from a production agent.

- **core**: the domain-agnostic runtime — prompt assembly from markdown skills (typed
  variants, capabilities, security preamble), the model chain (Anthropic, any OpenAI-compatible
  endpoint, a scripted mock) with failover, breaker, retries and per-endpoint configuration,
  MCP tools with reconnect and hidden `internal_*` tools, sessions with bounded memory and
  healed history windows, durable stores with fallback, two-stage tool-output trimming,
  **runtime-owned steps** (draw / read / settle / chain / late draw / redraw / review / carry /
  dependencies / reload redraw), whole-content readers, the create gate and attested-list guard,
  tolerant ui-block parsing and sanitising, OpenTelemetry seam, structured logs off the main thread.
- **verdict**: typed decisions (`choice` / `noul` / `score`) with rules, System One (Laya / any
  compatible server), LLM logprobs and mock backends; a cascade; calibration maths; a CLI, an
  MCP server and a System One-compatible HTTP server.
- **gateway**: HTTP + SSE; sessions with verified identity and owner checks; the agent-token
  exchange; rate limits with runtime-turn refunds; usage caps in plan tokens shown as
  percentages; media (upload ≠ attach); voice (Deepgram or any Whisper-compatible endpoint);
  nudges; health, metrics, HTTP tracing; a metering sink; graceful shutdown.
- **evals**: the scenario runner with sharding, reruns, flake classification and a gate report.
- **widget**: streaming, chips, multichips, lists, cards with sections, toggles, forms with
  echoes, tables, progress, media, bars; resume, nudges, voice, uploads; link scheme allowlist.
- **example**: support ticket intake, end to end offline with a scripted mock model; 7 scenarios.
- **checks**: `check:otel` (the telemetry seam against in-memory exporters and a stub log sink),
  `check:scaffold` (the templates produce a domain that compiles and passes its own suite),
  `check:e2e` (the real write path with writes on); the widget driven under a fake DOM in tests.
- **observability**: Docker Compose for OpenObserve (+ optional collector), generated dashboards
  and alerts (`o2:dashboards`), an idempotent `o2:bootstrap`.
- **deploy**: a non-root Dockerfile with a health check, Compose profiles (stores, observability,
  decisions with Ollama + laya, edge with Caddy), a production env example, DEPLOY.md; a CI workflow.
- **docs**: the pattern, the lessons, the playbook, the production checklist, the client
  protocol, decisions, observability, metering, security, the auth design, six ADRs, guides, templates.
