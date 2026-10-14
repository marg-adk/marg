# Integrations

Everything Marg plugs into is an environment line or a folder — no adapters to write. Models are on their own page: [Models](../providers/README.md).

## Observability

| | |
|---|---|
| [OpenObserve (default)](openobserve.md) | The open-source default: traces, metrics and logs over OTLP/protobuf, with dashboards and alerts as code (`npm run o2:bootstrap` creates them idempotently). |
| [Any OTLP backend](otlp.md) | Marg emits OpenTelemetry in the GenAI semantic conventions (`gen_ai.*` on model and tool spans, `agent_*` metrics, logs that carry the trace id). |
| [Langfuse](langfuse.md) | Langfuse ingests OTLP traces and maps the GenAI attributes to its generations view: model, tokens, cost per turn. |
| [Datadog](datadog.md) | Send OTLP to the Datadog Agent (OTLP ingest on 4318) or an OpenTelemetry Collector with the Datadog exporter; LLM Observability picks up the `gen_ai.*` spans. |
| [Grafana Cloud (Tempo, Mimir, Loki)](grafana.md) | Grafana Cloud's OTLP gateway takes traces, metrics and logs in one endpoint; the dashboards in `observability/openobserve/` translate to Grafana panels query by query (`npm run o2:dashboards` prints them as JSON). |
| [Honeycomb](honeycomb.md) | Honeycomb takes OTLP/protobuf directly; one dataset per `OTEL_SERVICE_NAME`. |
| [Arize Phoenix](phoenix.md) | Phoenix (open source) and Arize AX read OTLP traces with the GenAI attributes into their LLM trace and eval views. |
| [SigNoz](signoz.md) | Open-source APM on ClickHouse; traces, metrics and logs over OTLP. |
| [New Relic](newrelic.md) | New Relic's OTLP endpoint (EU or US); AI Monitoring reads the `gen_ai.*` spans. |
| [Jaeger (traces only)](jaeger.md) | Traces over OTLP; metrics and logs need another backend or a collector that fans out. |

## Stores

| | |
|---|---|
| [Redis (rate limits, caps)](redis.md) | Counters for rate limits and usage caps across gateway replicas. |
| [MongoDB (sessions, ledgers)](mongodb.md) | Sessions, the usage ledger and events, durable across restarts and shared by replicas. |

## Speech

| | |
|---|---|
| [Deepgram (voice notes)](deepgram.md) | The widget's mic sends a voice note; the transcript lands in the composer for review before it is sent. |
| [Whisper-compatible (OpenAI, Groq, self-hosted)](whisper.md) | Any `/audio/transcriptions` endpoint: OpenAI, Groq, or a self-hosted faster-whisper / whisper.cpp server — the same provider branch. |

## Decisions

| | |
|---|---|
| [Laya and System One servers](laya.md) | The decision model in Verdict's cascade: routing, reading a confirmation, checking a condition, answered with calibrated probabilities in ~30 ms before an LLM is asked. |

## Tools

| | |
|---|---|
| [MCP tool servers (any language)](mcp.md) | Your backend sits behind an MCP server the gateway spawns over stdio: TypeScript (the templates), Python (FastMCP), Go, Java, anything. |
| [From another agent framework](other-frameworks.md) | Two seams. |

## Hosting

| | |
|---|---|
| [Render, Fly, Railway, Docker](render.md) | One non-root image with a health check; Compose profiles for the stores, observability, decisions and the TLS edge; a Render Blueprint for a demo. |

## Coding agents

| | |
|---|---|
| [Claude Code, Codex and other coding agents](coding-agents.md) | The method for building a domain ships as a skill a coding agent follows: the worksheet, the build order, the gate, the classification rule. |
