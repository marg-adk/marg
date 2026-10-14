# Grafana Cloud (Tempo, Mimir, Loki)

Grafana Cloud's OTLP gateway takes traces, metrics and logs in one endpoint; the dashboards in `observability/openobserve/` translate to Grafana panels query by query (`npm run o2:dashboards` prints them as JSON).

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-prod-eu-west-2.grafana.net/otlp
OTEL_EXPORTER_OTLP_HEADERS=authorization=Basic $(echo -n INSTANCE_ID:GLCLOUD_TOKEN | base64)
```

Docs: https://grafana.com/docs/grafana-cloud/send-data/otlp/
