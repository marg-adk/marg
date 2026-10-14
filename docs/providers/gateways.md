# AI gateways: Apigee, Portkey, Kong, Cloudflare

Any gateway that proxies OpenAI-compatible chat completions (Apigee AI Gateway, Portkey, Kong AI Gateway, Cloudflare AI Gateway, Helicone) is a preset plus a base URL. Reuse the `openai` preset under your own name with `LLM_<NAME>_PRESET=openai` and point `_BASE` at the gateway; a non-bearer header is `LLM_<NAME>_AUTH_HEADER`.

```bash
LLM_CHAIN=gateway
LLM_GATEWAY_PRESET=openai
LLM_GATEWAY_BASE=https://your-gateway.example.com/v1
LLM_GATEWAY_API_KEY=…
LLM_GATEWAY_MODEL=gpt-5.6-luna
```

Every endpoint takes the same knobs: `LLM_<NAME>_TEMPERATURE` (`none` omits it), `LLM_<NAME>_BODY` (JSON merged into every request), `LLM_<NAME>_PRICE` (`input,cached,output` per million, for the cost ledger), `LLM_<NAME>_NOTES` (a per-model notes file). Two models of one provider: `LLM_FAST_PRESET=openai` under another name. [Environment](../ENVIRONMENT.md) has the full list.

Check it: `npm run gateway`, then `curl localhost:8787/api/health` — the `llm.chain` entry shows the endpoint, whether its key is set, and its state.

Provider docs: https://cloud.google.com/apigee/docs
