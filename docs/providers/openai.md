# OpenAI

Responses go through `/v1/chat/completions` with `max_completion_tokens`; `LLM_OPENAI_REASONING_EFFORT=low|medium|high|none` sets the reasoning field (`omit` drops it). Temperature is omitted by default for the reasoning models.

```bash
LLM_CHAIN=openai,anthropic   # failover to a second endpoint is one more name
LLM_OPENAI_API_KEY=sk-…
LLM_OPENAI_MODEL=gpt-5.6-luna
```

Every endpoint takes the same knobs: `LLM_<NAME>_TEMPERATURE` (`none` omits it), `LLM_<NAME>_BODY` (JSON merged into every request), `LLM_<NAME>_PRICE` (`input,cached,output` per million, for the cost ledger), `LLM_<NAME>_NOTES` (a per-model notes file). Two models of one provider: `LLM_FAST_PRESET=openai` under another name. [Environment](../ENVIRONMENT.md) has the full list.

Check it: `npm run gateway`, then `curl localhost:8787/api/health` — the `llm.chain` entry shows the endpoint, whether its key is set, and its state.

Provider docs: https://platform.openai.com/docs
