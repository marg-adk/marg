# Google Gemma (open weights)

Gemma is a model, not an API: serve it with Ollama, vLLM or llama.cpp locally, or pick it on a hosted provider (Groq, Together, Fireworks). Everything below the model line is unchanged.

```bash
LLM_CHAIN=ollama,anthropic   # failover to a second endpoint is one more name
LLM_OLLAMA_MODEL=gemma3:12b
# or on Groq: LLM_GROQ_MODEL=gemma2-9b-it  LLM_GROQ_API_KEY=…
```

Every endpoint takes the same knobs: `LLM_<NAME>_TEMPERATURE` (`none` omits it), `LLM_<NAME>_BODY` (JSON merged into every request), `LLM_<NAME>_PRICE` (`input,cached,output` per million, for the cost ledger), `LLM_<NAME>_NOTES` (a per-model notes file). Two models of one provider: `LLM_FAST_PRESET=ollama` under another name. [Environment](../ENVIRONMENT.md) has the full list.

Check it: `npm run gateway`, then `curl localhost:8787/api/health` — the `llm.chain` entry shows the endpoint, whether its key is set, and its state.

Provider docs: https://ai.google.dev/gemma
