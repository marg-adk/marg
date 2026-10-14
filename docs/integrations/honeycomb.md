# Honeycomb

Honeycomb takes OTLP/protobuf directly; one dataset per `OTEL_SERVICE_NAME`.

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io
OTEL_EXPORTER_OTLP_HEADERS=x-honeycomb-team=…
```

Docs: https://docs.honeycomb.io/send-data/opentelemetry/
