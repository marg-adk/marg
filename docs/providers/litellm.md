# LiteLLM (proxy to 100+ providers)

One OpenAI-compatible endpoint in front of Bedrock, Vertex, Azure, Cohere, Replicate, Sagemaker and more, with its own keys, budgets and routing. Marg sees one endpoint; LiteLLM's model name picks the provider.

```bash
LLM_CHAIN=litellm,anthropic   # failover to a second endpoint is one more name
LLM_LITELLM_BASE=http://localhost:4000/v1
LLM_LITELLM_API_KEY=sk-…   # the proxy's virtual key
LLM_LITELLM_MODEL=bedrock/anthropic.claude-sonnet-4-5
```

Every endpoint takes the same knobs: `LLM_<NAME>_TEMPERATURE` (`none` omits it), `LLM_<NAME>_BODY` (JSON merged into every request), `LLM_<NAME>_PRICE` (`input,cached,output` per million, for the cost ledger), `LLM_<NAME>_NOTES` (a per-model notes file). Two models of one provider: `LLM_FAST_PRESET=litellm` under another name. [Environment](../ENVIRONMENT.md) has the full list.

Check it: `npm run gateway`, then `curl localhost:8787/api/health` — the `llm.chain` entry shows the endpoint, whether its key is set, and its state.

Provider docs: https://docs.litellm.ai
