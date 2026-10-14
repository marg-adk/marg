# OpenObserve (default)

The open-source default: traces, metrics and logs over OTLP/protobuf, with dashboards and alerts as code (`npm run o2:bootstrap` creates them idempotently). The trace tree of a turn, the metrics and the standing rule are in [Observability](../OBSERVABILITY.md).

```bash
AGENT_O2_URL=http://localhost:5080
AGENT_O2_USER=root@example.com
AGENT_O2_PASSWORD=…
# docker compose -f observability/docker-compose.yml up -d  → npm run o2:bootstrap
```

Docs: https://openobserve.ai/docs
