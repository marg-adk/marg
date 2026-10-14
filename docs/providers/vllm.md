# vLLM (self-hosted)

vLLM serves OpenAI-compatible chat completions with logprobs, so Verdict's LLM link gets a real distribution. Set `LLM_VLLM_BASE` to your server.

```bash
LLM_CHAIN=vllm,anthropic   # failover to a second endpoint is one more name
LLM_VLLM_BASE=http://localhost:8000/v1
LLM_VLLM_MODEL=meta-llama/Llama-3.3-70B-Instruct
# LLM_VLLM_API_KEY only if you started vLLM with --api-key
```

Every endpoint takes the same knobs: `LLM_<NAME>_TEMPERATURE` (`none` omits it), `LLM_<NAME>_BODY` (JSON merged into every request), `LLM_<NAME>_PRICE` (`input,cached,output` per million, for the cost ledger), `LLM_<NAME>_NOTES` (a per-model notes file). Two models of one provider: `LLM_FAST_PRESET=vllm` under another name. [Environment](../ENVIRONMENT.md) has the full list.

Check it: `npm run gateway`, then `curl localhost:8787/api/health` — the `llm.chain` entry shows the endpoint, whether its key is set, and its state.

Provider docs: https://docs.vllm.ai
