# MongoDB (sessions, ledgers)

Sessions, the usage ledger and events, durable across restarts and shared by replicas. Unset, sessions live in files under `AGENT_SESSION_DIR` and ledgers in JSONL. [ADR-0002](../adr/0002-durable-stores.md).

```bash
AGENT_MONGO_URL=mongodb://localhost:27017
AGENT_MONGO_DB=marg
```

Docs: https://www.mongodb.com/docs/
