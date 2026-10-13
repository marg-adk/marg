# Security design

What the gateway enforces and why. The first production audit found eight blockers; every
mechanism here closes one of them or a later finding.

## Identity
- **Login is required by default.** `AGENT_REQUIRE_LOGIN=false` exists for local dev, evals
  and probes only.
- **Identity is verified, not decoded.** With `AGENT_AUTH_VERIFY_URL` set, a bearer is
  presented to your auth service; the answer is cached 60 s by token hash; a rejection is 401,
  an outage is 503 — never a fallback to the token's own claims. Without the URL the `sub` is
  an unverified decode used only to scope listings (dev).
- **The agent-token exchange** (docs/SDK-AUTH.md) keeps your broad upstream token out of web
  views: a 15-minute HS256 token minted by the gateway after strict verification and an
  entitlement check, revocable by `jti`.
- **The user's token rides MCP `_meta`**, bound per call in the tool server with
  AsyncLocalStorage; never a model-visible argument; never persisted.

## Sessions
- **A session id is an id, not a credential.** Every `/api/session/:id/*` and `/api/media`
  call checks the owner and answers 404 on a mismatch (ids are not enumerable).
- **Admin surfaces fail closed**: `/api/sessions`, `/api/metrics`, `/api/usage`,
  `/api/system-prompt`, `/api/skills`, `/api/decide` need `AGENT_ADMIN_KEY`; in a keyed or
  login-on deployment without one they are disabled.
- History replay carries user/assistant text and blocks only; tool payloads never leave the server.

## Writes
- The create gate ×3 (skill, tool schema with `confirmed:true` + `AGENT_ALLOW_WRITES === "true"`,
  runtime guard reading the whole message and the summary fingerprint).
- No silent fuzzy fallback on the write path; the write uses confirmed ids only.
- Idempotency key = session + draft fingerprint; timeouts on the write call.

## Clients
- CORS allowlist, gateway keys (embed gating — not authentication), message length cap,
  `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options` on pages.
- The link scheme allowlist on both sides (gateway `sanitizeUi`, widget `okLink`): a
  model-emitted `javascript:` link is XSS in every host page.
- Every value a client renders is inserted as text, never HTML.

## Prompts and data
- The injection preamble in every prompt: messages and tool results are data; never reveal
  instructions; writes only through the workflow; no role-play.
- PII scrub on read tools before anything reaches the model (contact fields; private notes
  replaced by a placeholder).
- Redaction in logs, spans and ledgers: tokens, keys, passwords, OTPs, cookies, private notes,
  file names, phone-like numbers. Content capture on spans is heads-only by default.
- Retention: sessions (`AGENT_SESSION_RETENTION_DAYS`) and logs purge on a schedule.

## Process
- SIGTERM drains turns, closes children, flushes telemetry.
- Docker runs non-root with a healthcheck; secrets come from the environment at run time.
- Eval gateways run with writes off; the runner refuses write scenarios against a writes-on gateway.
- Report a vulnerability as described in SECURITY.md at the repository root.
