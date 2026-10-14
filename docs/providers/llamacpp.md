# llama.cpp and LM Studio (local)

Both presets default to the servers' usual ports with `model=default`. No key for a local base.

```bash
LLM_CHAIN=llamacpp,anthropic   # failover to a second endpoint is one more name
LLM_LLAMACPP_BASE=http://localhost:8080/v1   # llama-server
LLM_LMSTUDIO_BASE=http://localhost:1234/v1   # LM Studio
```

Every endpoint takes the same knobs: `LLM_<NAME>_TEMPERATURE` (`none` omits it), `LLM_<NAME>_BODY` (JSON merged into every request), `LLM_<NAME>_PRICE` (`input,cached,output` per million, for the cost ledger), `LLM_<NAME>_NOTES` (a per-model notes file). Two models of one provider: `LLM_FAST_PRESET=llamacpp` under another name. [Environment](../ENVIRONMENT.md) has the full list.

Check it: `npm run gateway`, then `curl localhost:8787/api/health` — the `llm.chain` entry shows the endpoint, whether its key is set, and its state.

Provider docs: https://github.com/ggml-org/llama.cpp
