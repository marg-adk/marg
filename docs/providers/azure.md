# Azure OpenAI

Azure's v1 endpoint (no `api-version` query): the key travels in the `api-key` header (the preset sets `LLM_AZURE_AUTH_HEADER`), and the model is your deployment name. For Entra ID tokens set `LLM_AZURE_AUTH_HEADER=` empty and pass the bearer as the key.

```bash
LLM_CHAIN=azure,anthropic   # failover to a second endpoint is one more name
LLM_AZURE_BASE=https://RESOURCE.openai.azure.com/openai/v1
LLM_AZURE_API_KEY=…
LLM_AZURE_MODEL=my-gpt-deployment
```

Every endpoint takes the same knobs: `LLM_<NAME>_TEMPERATURE` (`none` omits it), `LLM_<NAME>_BODY` (JSON merged into every request), `LLM_<NAME>_PRICE` (`input,cached,output` per million, for the cost ledger), `LLM_<NAME>_NOTES` (a per-model notes file). Two models of one provider: `LLM_FAST_PRESET=azure` under another name. [Environment](../ENVIRONMENT.md) has the full list.

Check it: `npm run gateway`, then `curl localhost:8787/api/health` — the `llm.chain` entry shows the endpoint, whether its key is set, and its state.

Provider docs: https://learn.microsoft.com/azure/ai-services/openai/
