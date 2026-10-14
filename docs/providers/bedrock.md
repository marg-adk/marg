# Amazon Bedrock

Bedrock's OpenAI-compatible endpoint with a Bedrock API key as the bearer; the region is in the base URL. For SigV4 or cross-region inference profiles put LiteLLM in front instead.

```bash
LLM_CHAIN=bedrock,anthropic   # failover to a second endpoint is one more name
LLM_BEDROCK_BASE=https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1
LLM_BEDROCK_API_KEY=ABSK…
LLM_BEDROCK_MODEL=anthropic.claude-sonnet-4-5
```

Every endpoint takes the same knobs: `LLM_<NAME>_TEMPERATURE` (`none` omits it), `LLM_<NAME>_BODY` (JSON merged into every request), `LLM_<NAME>_PRICE` (`input,cached,output` per million, for the cost ledger), `LLM_<NAME>_NOTES` (a per-model notes file). Two models of one provider: `LLM_FAST_PRESET=bedrock` under another name. [Environment](../ENVIRONMENT.md) has the full list.

Check it: `npm run gateway`, then `curl localhost:8787/api/health` — the `llm.chain` entry shows the endpoint, whether its key is set, and its state.

Provider docs: https://docs.aws.amazon.com/bedrock/latest/userguide/inference-chat-completions.html
