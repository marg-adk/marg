# Hugging Face Inference Providers

The router at `router.huggingface.co/v1` picks a provider for the model (or append `:provider`).

```bash
LLM_CHAIN=huggingface,anthropic   # failover to a second endpoint is one more name
LLM_HUGGINGFACE_API_KEY=hf_…
LLM_HUGGINGFACE_MODEL=meta-llama/Llama-3.3-70B-Instruct
```

Every endpoint takes the same knobs: `LLM_<NAME>_TEMPERATURE` (`none` omits it), `LLM_<NAME>_BODY` (JSON merged into every request), `LLM_<NAME>_PRICE` (`input,cached,output` per million, for the cost ledger), `LLM_<NAME>_NOTES` (a per-model notes file). Two models of one provider: `LLM_FAST_PRESET=huggingface` under another name. [Environment](../ENVIRONMENT.md) has the full list.

Check it: `npm run gateway`, then `curl localhost:8787/api/health` — the `llm.chain` entry shows the endpoint, whether its key is set, and its state.

Provider docs: https://huggingface.co/docs/inference-providers
