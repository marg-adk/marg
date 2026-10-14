# Arize Phoenix

Phoenix (open source) and Arize AX read OTLP traces with the GenAI attributes into their LLM trace and eval views.

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:6006   # phoenix serve
# Arize AX: OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.arize.com  OTEL_EXPORTER_OTLP_HEADERS=api_key=…,space_id=…
```

Docs: https://arize.com/docs/phoenix
