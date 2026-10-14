# Cohere

Cohere's compatibility endpoint (`/compatibility/v1`); tool calling works.

```bash
LLM_CHAIN=cohere,anthropic   # failover to a second endpoint is one more name
LLM_COHERE_API_KEY=…
LLM_COHERE_MODEL=command-a-03-2025
```

Every endpoint takes the same knobs: `LLM_<NAME>_TEMPERATURE` (`none` omits it), `LLM_<NAME>_BODY` (JSON merged into every request), `LLM_<NAME>_PRICE` (`input,cached,output` per million, for the cost ledger), `LLM_<NAME>_NOTES` (a per-model notes file). Two models of one provider: `LLM_FAST_PRESET=cohere` under another name. [Environment](../ENVIRONMENT.md) has the full list.

Check it: `npm run gateway`, then `curl localhost:8787/api/health` — the `llm.chain` entry shows the endpoint, whether its key is set, and its state.

Provider docs: https://docs.cohere.com/docs/compatibility-api
