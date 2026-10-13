# Production-readiness checklist

Every item here was a real blocker or incident in the first production vertical (an audit
found eight blockers; the hardening that followed produced this list). Walk it before any
deploy; walk §1–3 at design time.

## 1. Identity & session security
- [ ] Login required (`AGENT_REQUIRE_LOGIN` unset = on). Dev convenience never becomes identity.
- [ ] Identity VERIFIED against your auth service (`AGENT_AUTH_VERIFY_URL`), cached 60 s, failing closed (401 on rejection, 503 when unreachable). A bare JWT decode scopes listings in dev only.
- [ ] A session id is never a credential: every session route checks the owner and answers 404 on a mismatch.
- [ ] Admin routes (`/api/sessions`, `/api/metrics`, `/api/usage`, `/api/system-prompt`, `/api/decide`) require `AGENT_ADMIN_KEY` and are DISABLED when none is set in a keyed/login deployment.
- [ ] The user's token rides MCP `_meta`, never model-visible arguments; never persisted; re-supplied per turn. An agent-token exchange keeps the broad upstream token out of web views (docs/SDK-AUTH.md).
- [ ] Tokens, keys, passwords, OTPs and private notes never appear in logs (`redact()`), spans or ledgers.

## 2. Write-path integrity
- [ ] The confirm gate ×3: skill rule, tool schema (`confirmed:true` + `AGENT_ALLOW_WRITES === "true"`), runtime guard (summary shown for this draft + whole-content yes).
- [ ] The backend was PROBED: real mandatories, schema warts, which base URLs share a database, whether a GET writes. Findings live in the schema registry.
- [ ] Timeout + idempotency on the write (key = session + draft fingerprint; reconcile before retrying).
- [ ] No silent fuzzy fallback on the write path; the write uses only ids the user confirmed.
- [ ] Links are tool-composed or templated (`AGENT_ENTITY_DEEPLINK`), never model-invented; the scheme allowlist is on (`AGENT_LINK_SCHEMES` for your app's scheme).
- [ ] Attested lists configured for anything published under the user's name (`attested_lists`).

## 3. Client security
- [ ] CORS allowlist (`AGENT_CORS_ORIGINS`), gateway keys (`AGENT_GATEWAY_KEYS`), message cap (`AGENT_MAX_MESSAGE_CHARS`), security headers (always on).
- [ ] History replay carries user/assistant prose + blocks only; tool payloads never leave the server.
- [ ] The injection preamble is in every prompt; an injection scenario is in every suite.
- [ ] The widget script URL is pinned to its version behind any caching proxy.

## 4. Lifecycle & resilience
- [ ] SIGTERM drains in-flight turns (bounded), closes MCP children, flushes logs and telemetry.
- [ ] MCP children reconnect on a transport failure (built in); `/api/health` shows reconnect counts.
- [ ] Sessions hydrate lazily and evict (`AGENT_SESSION_CACHE`); nothing loads everything at boot.
- [ ] History windows on turn boundaries and heals tool pairs (built in).
- [ ] Degradation paths are typed and friendly: model chain exhausted → 503 with the draft saved; counter store down → fail open; STT down → a typed error.
- [ ] `/api/health` is the deploy's readiness probe (503 when no key or no tools).

## 5. Cost & abuse
- [ ] Rate limits on session creation, turns per session, turns per IP, uploads, transcriptions; one in-flight turn per session; a global in-flight cap; `AGENT_TRUST_PROXY` only behind a proxy.
- [ ] Usage caps in plan tokens per user (5h/day/week/month) and per session; context cap; users see a percentage.
- [ ] Tool-output trimming on; the typed prompt on for multi-variant domains; a cheap decision instead of a model call for routing.
- [ ] Model endpoints priced (`LLM_<NAME>_PRICE`) so the ledger carries vendor cost; metering sink configured if you bill.

## 6. Observability
- [ ] `AGENT_O2_URL` (or an OTLP collector) set; traces, metrics and logs arrive; the behaviour panel shows runtime interventions.
- [ ] Alerts: turn error ratio, model unavailable, circuit open, rate-limit bursts, p95 latency, cost per hour.
- [ ] `npm run check:otel` green in CI; the privacy scan finds no user text in labels.
- [ ] Structured logs ship off the main thread; retention set (`AGENT_LOG_RETENTION_DAYS`, `AGENT_SESSION_RETENTION_DAYS`).

## 7. Deploy hygiene
- [ ] Docker runs as a non-root user with a HEALTHCHECK; images build from the repo root.
- [ ] A compose stack with TLS in front (deploy/) and a tested runbook (deploy/DEPLOY.md).
- [ ] `.env.production.example` documents EVERY variable and stays current.
- [ ] Multi-node: Redis + Mongo configured; sticky sessions recommended (in-flight guards are per node).

## 8. Data safety rails (dev time)
- [ ] All writes gated by `AGENT_ALLOW_WRITES=true`; the eval gateway runs with writes off; the runner refuses write scenarios otherwise.
- [ ] Probe/seed scripts require `--yes`, tag their records, clean up, report what they could not clean.
- [ ] Secrets only in `.env` (gitignored); a committed `.env.example` with placeholders.
- [ ] PII scrubbed from read-tool results (contact fields) before anything reaches the model.
