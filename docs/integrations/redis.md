# Redis (rate limits, caps)

Counters for rate limits and usage caps across gateway replicas. Unset, counters live in memory (fine for one replica); a Redis outage falls back with a warning rather than failing boot.

```bash
AGENT_REDIS_URL=redis://localhost:6379
```

Docs: https://redis.io/docs/
