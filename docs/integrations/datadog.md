# Datadog

Send OTLP to the Datadog Agent (OTLP ingest on 4318) or an OpenTelemetry Collector with the Datadog exporter; LLM Observability picks up the `gen_ai.*` spans.

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318   # the Datadog Agent's OTLP intake (enable otlp_config in datadog.yaml)
# or the collector with the datadog exporter
```

Docs: https://docs.datadoghq.com/opentelemetry/
