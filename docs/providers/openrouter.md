# OpenRouter

One key, every provider; the model id names the provider. Failover across providers is OpenRouter's; the chain's failover is Marg's — use either or both.

```bash
LLM_CHAIN=openrouter,anthropic   # failover to a second endpoint is one more name
LLM_OPENROUTER_API_KEY=sk-or-…
LLM_OPENROUTER_MODEL=anthropic/claude-sonnet-4.5
```

Every endpoint takes the same knobs: `LLM_<NAME>_TEMPERATURE` (`none` omits it), `LLM_<NAME>_BODY` (JSON merged into every request), `LLM_<NAME>_PRICE` (`input,cached,output` per million, for the cost ledger), `LLM_<NAME>_NOTES` (a per-model notes file). Two models of one provider: `LLM_FAST_PRESET=openrouter` under another name. [Environment](../ENVIRONMENT.md) has the full list.

Check it: `npm run gateway`, then `curl localhost:8787/api/health` — the `llm.chain` entry shows the endpoint, whether its key is set, and its state.

Provider docs: https://openrouter.ai/docs
