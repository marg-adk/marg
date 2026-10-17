# Environment variables

Unset = the safe default. Every hardening feature is opt-in; every write flag must equal the
literal string `"true"`; stores fall back with a warning rather than failing boot.

## Model chain (`LLM_*`)
| Variable | Meaning |
|---|---|
| `LLM_CHAIN` | Ordered endpoint names, e.g. `openai,anthropic`, `ollama`, `mock`. Unset ⇒ legacy single provider (`ANTHROPIC_API_KEY` / `LLM_API_BASE`+`LLM_MODEL`) or the mock. |
| `LLM_<NAME>_PRESET` | Reuse a preset under another name (two models of one provider). Presets: anthropic, mock, openai, gemini, vertex, azure, bedrock, ollama, vllm, llamacpp, lmstudio, litellm, groq, mistral, deepseek, fireworks, together, openrouter, xai, cohere, huggingface, cerebras, perplexity, nvidia — one page each in [providers/](providers/README.md). |
| `LLM_<NAME>_BASE` / `_MODEL` / `_API_KEY` | The endpoint. Local bases need no key. |
| `LLM_<NAME>_TEMPERATURE` | number or `none` (omit the field). |
| `LLM_<NAME>_REASONING_EFFORT` | `low`/`medium`/`high`/`none`/`omit`. |
| `LLM_<NAME>_BODY` | JSON merged into every request (`null` removes a preset field). |
| `LLM_<NAME>_PRICE` | `input,cached,output[,cache_write]` USD per million. |
| `LLM_<NAME>_NOTES` | Per-model notes file (`none` to disable); default `shared-skills/model-notes/<slug>.md`. |
| `LLM_<NAME>_AUTH_HEADER` | Send the key in this header instead of `Authorization: Bearer`. |
| `LLM_FAILOVER_THRESHOLD` (2), `LLM_FAILOVER_COOLDOWN_S` (60), `LLM_RETRIES` (2), `LLM_RETRY_MAX_WAIT_MS` (20000), `LLM_TIMEOUT_MS` (120000) | Breaker and retries. |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | The anthropic preset. |
| `AGENT_ROUTER_MODEL`, `AGENT_ROUTER_MIN_CONFIDENCE` (0.35) | Routing hop. |

## Typed decisions (`VERDICT_*`)
`VERDICT_SYSTEMONE_URL`, `VERDICT_SYSTEMONE_MODEL` (laya), `VERDICT_SYSTEMONE_API_KEY`,
`VERDICT_MIN_CONFIDENCE` (0.6), `VERDICT_ESCALATE_BELOW` (0.5), `VERDICT_LLM` (`off` disables the LLM link).

## Safety and identity (`AGENT_*`)
| Variable | Default | Meaning |
|---|---|---|
| `AGENT_ALLOW_WRITES` | unset (off) | Real writes only when literally `true`. |
| `AGENT_REQUIRE_LOGIN` | on | `false` only for dev/evals/probe. |
| `AGENT_DEV_TRACE` | unset (off) | The dev UI's trace content: only when literally `true`, a turn's route decision, step events, tool arguments and results and model timings go to the client (`trace` on `done`, `turns` on `/history`; [client protocol](CLIENT-PROTOCOL.md#the-dev-trace)) and the last 30 turns are kept on the session. Never on telemetry. `.env.example` sets it; production leaves it off. |
| `AGENT_AUTH_VERIFY_URL` | — | Strict identity verification endpoint (GET with the bearer). |
| `AGENT_TOKEN_SECRET`, `AGENT_TOKEN_TTL_S` (900), `AGENT_APP_KEYS` (`key:tenant,…`) | — | The agent-token exchange. |
| `AGENT_ENTITLEMENT_URL`, `AGENT_ENTITLEMENT_KEY` | — | Seats and caps at exchange. |
| `AGENT_GATEWAY_KEYS`, `AGENT_ADMIN_KEY`, `AGENT_CORS_ORIGINS`, `AGENT_TRUST_PROXY`, `AGENT_MAX_MESSAGE_CHARS` (4000), `AGENT_LINK_SCHEMES` | — | Gateway hardening. |
| `AGENT_GUARDS` | on | `false` disables the runtime guards (raw-model evals only). |
| `AGENT_TYPED_PROMPT` | on | `false` loads every type's skill and tools. |
| `AGENT_LEXICONS` | — | Registers for the readers, comma-separated (`hinglish`); the core is English ([readers](guides/readers.md)). |

## Limits and cost
`AGENT_RATE_SESSIONS_PER_IP` (20), `AGENT_RATE_CHAT_PER_SESSION` (10), `AGENT_RATE_CHAT_PER_IP` (60),
`AGENT_RATE_TRANSCRIBE_PER_IP` (30), `AGENT_RATE_MEDIA_PER_IP` (60), `AGENT_RATE_MAX_CONCURRENT` (8),
`AGENT_RATE_DISABLED`; `AGENT_CAP_TOKENS_PER_SESSION`, `_5H`, `_DAY`, `_WEEK`, `_MONTH`,
`AGENT_CAP_CONTEXT_TOKENS`, `AGENT_CAP_TZ_OFFSET_MIN`; `AGENT_PLAN_WEIGHT_INPUT/CACHED/OUTPUT/CACHE_WRITE`;
`AGENT_TOOL_RESULT_MAX_CHARS` (12000), `AGENT_TOOL_RESULT_KEEP_CHARS` (1500), `AGENT_TRIM_TOOL_HISTORY_TURNS` (2);
`AGENT_MAX_TOOL_ROUNDS` (10); `AGENT_MAX_HISTORY_MESSAGES` (60); `AGENT_SESSION_CACHE` (2000).

## Stores, sessions, retention
`AGENT_REDIS_URL`, `AGENT_MONGO_URL`, `AGENT_MONGO_DB` (marg), `AGENT_SESSION_DIR` (.sessions),
`AGENT_SESSION_RETENTION_DAYS`, `AGENT_LEDGER_DIR` (.data/ledger).

## Channels
`DEEPGRAM_API_KEY` or `AGENT_STT_PROVIDER=openai` + `AGENT_STT_BASE` + `AGENT_STT_API_KEY`,
`AGENT_STT_MODEL`, `AGENT_STT_LANGUAGE`, `AGENT_STT_KEYWORDS`, `AGENT_STT_PRICE_PER_MIN`;
`AGENT_MEDIA_DOMAIN`, `AGENT_FILE_BASE`, `AGENT_MEDIA_MAX_IMAGE_MB` (15), `_FILE_MB` (25), `_VIDEO_MB` (128), `AGENT_MEDIA_MAX_ITEMS` (30);
`AGENT_ENTITY_DEEPLINK`, `AGENT_UPLOAD_DEEPLINK` (`{entity_id}` templates);
`AGENT_NUDGE_ENABLED`, `AGENT_NUDGE_MAX` (3), `AGENT_NUDGE_INTERVAL_MS` (300000), `AGENT_NUDGE_LINES`.

## Observability and logs
`AGENT_O2_URL`, `AGENT_O2_ORG` (default), `AGENT_O2_USER`, `AGENT_O2_PASSWORD` or `AGENT_O2_TOKEN`,
`AGENT_O2_LOG_STREAM`, `AGENT_O2_LOGS` (`off`), `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`,
`OTEL_SERVICE_NAME`, `OTEL_TRACES_SAMPLER_ARG`, `AGENT_OTEL` (`off`), `AGENT_OTEL_CAPTURE_CONTENT` (heads),
`AGENT_OTEL_METRICS_INTERVAL_MS` (15000); `LOG_LEVEL`, `AGENT_TRACE` (`off`), `AGENT_LOG_DIR`,
`AGENT_LOG_RETENTION_DAYS` (14), `AGENT_LOG_STDOUT`, `AGENT_LOG_SYNC`, `AGENT_LOG_TO_STDERR`,
`AGENT_REDACT_KEYS`, `AGENT_REDACT_PHONES`; `AGENT_ALERT_ERROR_RATIO` (0.5), `AGENT_ALERT_WEBHOOK`.

## Metering
`AGENT_METERING_URL`, `AGENT_METERING_API_KEY`, `AGENT_METERING_PRODUCT` (agent).

## Process
`GATEWAY_PORT` (8787), `AGENT_BRAND` (Marg), `AGENT_SERVICE_NAMESPACE` (marg), `AGENT_METRIC_PREFIX` (agent),
`AGENT_ENV` (local), `AGENT_DOMAIN_DIRS` (domains,examples), `AGENT_DOMAINS` (all), `AGENT_PUBLIC_DIR`,
`AGENT_WIDGET_FILE`, `AGENT_SHARED_SKILLS_DIR`, `AGENT_REPO_ROOT`, `AGENT_SHUTDOWN_GRACE_MS` (10000).
`AGENT_REPO_ROOT` defaults to the repository root when running from a checkout and to the
working directory's project (the nearest `package.json` or `.git`) when the packages are
installed from npm; `.env`, `domains/`, `examples/` and `shared-skills/` are read from there.

## Evals
`EVAL_GATEWAY` (http://localhost:8788), `SCENARIO`, `EVAL_SHARD` (`i/n`), `EVAL_RERUNS`, `EVAL_FLAKES`, `EVAL_VERBOSE`, `EVAL_BEARER`.
