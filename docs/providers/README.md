# Models

Marg talks to any model behind an OpenAI-compatible chat-completions endpoint, and to Anthropic natively. A chain of endpoints is one environment line (`LLM_CHAIN=openai,anthropic`): the first answers, the next takes over on failure, a circuit breaker rests a failing endpoint, and the scripted mock runs everything with no key. Switching providers changes nothing else — the runtime owns the moments that must be right, whichever model talks.

| Provider | Preset | Notes |
|---|---|---|
| [Anthropic (Claude)](anthropic.md) | `anthropic` (native) | The native Messages API adapter: streaming, tool use, prompt caching, usage with cache reads and writes |
| [OpenAI](openai.md) | `openai` | Responses go through /v1/chat/completions with max_completion_tokens; LLM_OPENAI_REASONING_EFFORT=low|medium|high|none sets the reasoning field (omit drops it) |
| [Google Gemini (AI Studio)](gemini.md) | `gemini` | Through Gemini's OpenAI-compatible endpoint (generativelanguage.googleapis.com/v1beta/openai) |
| [Google Cloud Vertex AI (Agent Platform)](vertex.md) | `vertex` | Vertex's OpenAI-compatible endpoint, with a short-lived OAuth access token as the bearer (Application Default Credentials — mint it with gcloud auth print-access-token, or from a service account in your deploy; rotate it before the hour is up) |
| [Google Gemma (open weights)](gemma.md) | `ollama` | Gemma is a model, not an API: serve it with Ollama, vLLM or llama.cpp locally, or pick it on a hosted provider (Groq, Together, Fireworks) |
| [Azure OpenAI](azure.md) | `azure` | Azure's v1 endpoint (no api-version query): the key travels in the api-key header (the preset sets LLM_AZURE_AUTH_HEADER), and the model is your deployment name |
| [Amazon Bedrock](bedrock.md) | `bedrock` | Bedrock's OpenAI-compatible endpoint with a Bedrock API key as the bearer; the region is in the base URL |
| [Ollama (local)](ollama.md) | `ollama` | Any model Ollama serves: Llama, Gemma, Qwen, Mistral, DeepSeek |
| [vLLM (self-hosted)](vllm.md) | `vllm` | vLLM serves OpenAI-compatible chat completions with logprobs, so Verdict's LLM link gets a real distribution |
| [llama.cpp and LM Studio (local)](llamacpp.md) | `llamacpp` | Both presets default to the servers' usual ports with model=default |
| [LiteLLM (proxy to 100+ providers)](litellm.md) | `litellm` | One OpenAI-compatible endpoint in front of Bedrock, Vertex, Azure, Cohere, Replicate, Sagemaker and more, with its own keys, budgets and routing |
| [AI gateways: Apigee, Portkey, Kong, Cloudflare](gateways.md) | `openai` | Any gateway that proxies OpenAI-compatible chat completions (Apigee AI Gateway, Portkey, Kong AI Gateway, Cloudflare AI Gateway, Helicone) is a preset plus a base URL |
| [Groq](groq.md) | `groq` | Fast open-weight models (Llama, Gemma, Qwen, Mistral) behind an OpenAI-compatible endpoint. |
| [Mistral](mistral.md) | `mistral` | La Plateforme's chat completions; tool calling works. |
| [DeepSeek](deepseek.md) | `deepseek` | deepseek-chat for tool use; the reasoning model does not take tools, so it suits the router hop (AGENT_ROUTER_MODEL) rather than the domain agent. |
| [Fireworks AI](fireworks.md) | `fireworks` | Hosted open-weight models with logprobs. |
| [Together AI](together.md) | `together` | Hosted open-weight models with logprobs. |
| [OpenRouter](openrouter.md) | `openrouter` | One key, every provider; the model id names the provider |
| [xAI (Grok)](xai.md) | `xai` | OpenAI-compatible chat completions. |
| [Cohere](cohere.md) | `cohere` | Cohere's compatibility endpoint (/compatibility/v1); tool calling works. |
| [Hugging Face Inference Providers](huggingface.md) | `huggingface` | The router at router.huggingface.co/v1 picks a provider for the model (or append :provider). |
| [Cerebras](cerebras.md) | `cerebras` | Very fast open-weight inference; OpenAI-compatible. |
| [Perplexity (Sonar)](perplexity.md) | `perplexity` | Search-grounded answers; no tool calling, so it suits an answer-only domain or the router hop, not a domain that writes. |
| [NVIDIA NIM](nvidia.md) | `nvidia` | The hosted catalogue at integrate.api.nvidia.com/v1, or a NIM container you run. |
| [LiteRT-LM and other on-device runtimes](litert.md) | — | Marg's gateway is a Node service; an on-device runtime (LiteRT-LM, MLC, MediaPipe) belongs in the client, not behind the gateway |

## How a preset works

A preset prefills the base URL and the auth style so `.env` only needs `LLM_<NAME>_MODEL` and `LLM_<NAME>_API_KEY`. Any name works: `LLM_<NAME>_PRESET=openai` reuses a preset under your own name (two models of one provider, a gateway in front of one). A base you set yourself (`LLM_<NAME>_BASE`) wins over the preset's. Local bases (`localhost`, `.local`) need no key.

## Logprobs and typed decisions

Verdict's last link asks the model for a one-token answer with logprobs. Endpoints that return them (OpenAI, vLLM, Fireworks, Together, Groq) give a calibrated distribution; endpoints that do not (Gemini, Ollama, Anthropic) still answer, without one — rules and a decision model (Laya) come first either way. [Decisions](../DECISIONS.md).

## The router hop

With two or more domains the super agent classifies each turn. `AGENT_ROUTER_MODEL` names a cheaper model for that hop; unset, the primary answers. Keyword rules from the manifests answer first and cost nothing.
