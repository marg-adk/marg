# DeepSeek

`deepseek-chat` for tool use; the reasoning model does not take tools, so it suits the router hop (`AGENT_ROUTER_MODEL`) rather than the domain agent.

```bash
LLM_CHAIN=deepseek,anthropic   # failover to a second endpoint is one more name
LLM_DEEPSEEK_API_KEY=sk-…
LLM_DEEPSEEK_MODEL=deepseek-chat
```

Every endpoint takes the same knobs: `LLM_<NAME>_TEMPERATURE` (`none` omits it), `LLM_<NAME>_BODY` (JSON merged into every request), `LLM_<NAME>_PRICE` (`input,cached,output` per million, for the cost ledger), `LLM_<NAME>_NOTES` (a per-model notes file). Two models of one provider: `LLM_FAST_PRESET=deepseek` under another name. [Environment](../ENVIRONMENT.md) has the full list.

Check it: `npm run gateway`, then `curl localhost:8787/api/health` — the `llm.chain` entry shows the endpoint, whether its key is set, and its state.

Provider docs: https://api-docs.deepseek.com
