# Google Gemini (AI Studio)

Through Gemini's OpenAI-compatible endpoint (`generativelanguage.googleapis.com/v1beta/openai`). Tool calling and streaming work; logprobs are not offered, so Verdict's LLM link answers without a distribution (rules and a decision model first).

```bash
LLM_CHAIN=gemini,anthropic   # failover to a second endpoint is one more name
LLM_GEMINI_API_KEY=AIza…
LLM_GEMINI_MODEL=gemini-2.5-pro
```

Every endpoint takes the same knobs: `LLM_<NAME>_TEMPERATURE` (`none` omits it), `LLM_<NAME>_BODY` (JSON merged into every request), `LLM_<NAME>_PRICE` (`input,cached,output` per million, for the cost ledger), `LLM_<NAME>_NOTES` (a per-model notes file). Two models of one provider: `LLM_FAST_PRESET=gemini` under another name. [Environment](../ENVIRONMENT.md) has the full list.

Check it: `npm run gateway`, then `curl localhost:8787/api/health` — the `llm.chain` entry shows the endpoint, whether its key is set, and its state.

Provider docs: https://ai.google.dev/gemini-api/docs/openai
