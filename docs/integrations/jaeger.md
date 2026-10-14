# Jaeger (traces only)

Traces over OTLP; metrics and logs need another backend or a collector that fans out.

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318   # jaeger all-in-one
```

Docs: https://www.jaegertracing.io/docs/
