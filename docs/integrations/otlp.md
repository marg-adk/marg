# Any OTLP backend

Marg emits OpenTelemetry in the GenAI semantic conventions (`gen_ai.*` on model and tool spans, `agent_*` metrics, logs that carry the trace id). Point `OTEL_EXPORTER_OTLP_ENDPOINT` at a collector or a vendor's OTLP intake and the headers at its auth; the pages below are that line for each vendor.

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://collector.example.com
OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer …   # comma-separated key=value
AGENT_OTEL_CAPTURE_CONTENT=heads   # heads | full | off
```

Docs: https://opentelemetry.io/docs/languages/js/
