# Ollama (local)

Any model Ollama serves: Llama, Gemma, Qwen, Mistral, DeepSeek. Local bases need no key. Logprobs are not available, so Verdict's LLM link answers without a distribution.

```bash
LLM_CHAIN=ollama,anthropic   # failover to a second endpoint is one more name
LLM_OLLAMA_MODEL=llama3.3
# base defaults to http://localhost:11434/v1 — no key for a local base
```

Every endpoint takes the same knobs: `LLM_<NAME>_TEMPERATURE` (`none` omits it), `LLM_<NAME>_BODY` (JSON merged into every request), `LLM_<NAME>_PRICE` (`input,cached,output` per million, for the cost ledger), `LLM_<NAME>_NOTES` (a per-model notes file). Two models of one provider: `LLM_FAST_PRESET=ollama` under another name. [Environment](../ENVIRONMENT.md) has the full list.

Check it: `npm run gateway`, then `curl localhost:8787/api/health` — the `llm.chain` entry shows the endpoint, whether its key is set, and its state.

Provider docs: https://ollama.com
