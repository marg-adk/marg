# Google Cloud Vertex AI (Agent Platform)

Vertex's OpenAI-compatible endpoint, with a short-lived OAuth access token as the bearer (Application Default Credentials — mint it with `gcloud auth print-access-token`, or from a service account in your deploy; rotate it before the hour is up). Model ids are prefixed with the publisher (`google/`, `meta/`, `anthropic/`… for Model Garden).

```bash
LLM_CHAIN=vertex,anthropic   # failover to a second endpoint is one more name
LLM_VERTEX_BASE=https://us-central1-aiplatform.googleapis.com/v1/projects/PROJECT/locations/us-central1/endpoints/openapi
LLM_VERTEX_API_KEY=$(gcloud auth print-access-token)
LLM_VERTEX_MODEL=google/gemini-2.5-pro
```

Every endpoint takes the same knobs: `LLM_<NAME>_TEMPERATURE` (`none` omits it), `LLM_<NAME>_BODY` (JSON merged into every request), `LLM_<NAME>_PRICE` (`input,cached,output` per million, for the cost ledger), `LLM_<NAME>_NOTES` (a per-model notes file). Two models of one provider: `LLM_FAST_PRESET=vertex` under another name. [Environment](../ENVIRONMENT.md) has the full list.

Check it: `npm run gateway`, then `curl localhost:8787/api/health` — the `llm.chain` entry shows the endpoint, whether its key is set, and its state.

Provider docs: https://cloud.google.com/vertex-ai/generative-ai/docs/start/openai
