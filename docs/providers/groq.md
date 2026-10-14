# Groq

Fast open-weight models (Llama, Gemma, Qwen, Mistral) behind an OpenAI-compatible endpoint.

```bash
LLM_CHAIN=groq,anthropic   # failover to a second endpoint is one more name
LLM_GROQ_API_KEY=gsk_…
LLM_GROQ_MODEL=llama-3.3-70b-versatile
```

Every endpoint takes the same knobs: `LLM_<NAME>_TEMPERATURE` (`none` omits it), `LLM_<NAME>_BODY` (JSON merged into every request), `LLM_<NAME>_PRICE` (`input,cached,output` per million, for the cost ledger), `LLM_<NAME>_NOTES` (a per-model notes file). Two models of one provider: `LLM_FAST_PRESET=groq` under another name. [Environment](../ENVIRONMENT.md) has the full list.

Check it: `npm run gateway`, then `curl localhost:8787/api/health` — the `llm.chain` entry shows the endpoint, whether its key is set, and its state.

Provider docs: https://console.groq.com/docs
