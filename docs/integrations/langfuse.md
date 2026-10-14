# Langfuse

Langfuse ingests OTLP traces and maps the GenAI attributes to its generations view: model, tokens, cost per turn.

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://cloud.langfuse.com/api/public/otel
OTEL_EXPORTER_OTLP_HEADERS=authorization=Basic $(echo -n pk-lf-…:sk-lf-… | base64)
```

Docs: https://langfuse.com/docs/opentelemetry/get-started
