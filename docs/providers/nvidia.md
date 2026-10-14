# NVIDIA NIM

The hosted catalogue at `integrate.api.nvidia.com/v1`, or a NIM container you run.

```bash
LLM_CHAIN=nvidia,anthropic   # failover to a second endpoint is one more name
LLM_NVIDIA_API_KEY=nvapi-…
LLM_NVIDIA_MODEL=meta/llama-3.3-70b-instruct
# self-hosted NIM: LLM_NVIDIA_BASE=http://localhost:8000/v1
```

Every endpoint takes the same knobs: `LLM_<NAME>_TEMPERATURE` (`none` omits it), `LLM_<NAME>_BODY` (JSON merged into every request), `LLM_<NAME>_PRICE` (`input,cached,output` per million, for the cost ledger), `LLM_<NAME>_NOTES` (a per-model notes file). Two models of one provider: `LLM_FAST_PRESET=nvidia` under another name. [Environment](../ENVIRONMENT.md) has the full list.

Check it: `npm run gateway`, then `curl localhost:8787/api/health` — the `llm.chain` entry shows the endpoint, whether its key is set, and its state.

Provider docs: https://docs.api.nvidia.com
