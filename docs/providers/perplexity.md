# Perplexity (Sonar)

Search-grounded answers; no tool calling, so it suits an answer-only domain or the router hop, not a domain that writes.

```bash
LLM_CHAIN=perplexity,anthropic   # failover to a second endpoint is one more name
LLM_PERPLEXITY_API_KEY=pplx-…
LLM_PERPLEXITY_MODEL=sonar-pro
```

Every endpoint takes the same knobs: `LLM_<NAME>_TEMPERATURE` (`none` omits it), `LLM_<NAME>_BODY` (JSON merged into every request), `LLM_<NAME>_PRICE` (`input,cached,output` per million, for the cost ledger), `LLM_<NAME>_NOTES` (a per-model notes file). Two models of one provider: `LLM_FAST_PRESET=perplexity` under another name. [Environment](../ENVIRONMENT.md) has the full list.

Check it: `npm run gateway`, then `curl localhost:8787/api/health` — the `llm.chain` entry shows the endpoint, whether its key is set, and its state.

Provider docs: https://docs.perplexity.ai
