# Embedding in your app: the agent-token exchange, seats and caps

> Settled design from a production integration (a mobile app hosting the widget in a web view
> with native bridges for photos and voice). Built into `packages/gateway/src/auth.ts`.

## Principles
1. **Your app authenticates the user** against your auth service. Nothing in the SDK or the
   gateway logs a user in.
2. **Your broad access token never enters a web view.** The native side exchanges it for a
   short-lived AGENT TOKEN that only the agent API accepts.
3. **Identity is verified once, at exchange, by calling your auth service — and fails closed.**
4. **A seat is checked at exchange and a cap is enforced before every turn.**
5. **A session id is an id, not a credential.** Every session endpoint checks the owner.

## The three credentials
| Credential | Held by | Lifetime | Goes to |
|---|---|---|---|
| Your access token (+ refresh) | the native app only | yours | `POST /api/auth/exchange` only |
| App key (`X-Agent-App-Key`) | the app build (one per platform/tenant) | until rotated | every gateway call; an identifier, not a secret |
| Agent token | the web view's JS memory + the native side | 15 min, renewed by the native side | every `/api/*` call |

## Flow
```
user ──login──▶ your auth service ──▶ access token held by the app
app  ── POST /api/auth/exchange [X-Agent-App-Key, Bearer <access token>] ──▶ gateway
gateway: app key → tenant ; GET AGENT_AUTH_VERIFY_URL (strict) → sub, name, firm ;
         GET AGENT_ENTITLEMENT_URL/{firm}/{sub} → seat + cap ; vault the access token ;
         mint {sub, firm_id, tenant, seat, jti, exp}
app  ◀── { agent_token, expires_in: 900, user, firm, seat, cap } ──
web view ── widget calls opts.token() (async) → agent token ──▶ every /api/* call
gateway: verify signature, exp, jti not revoked → bind the session's owner = sub →
         per tool call, attach the VAULTED access token (acts as the user; your API enforces permissions)
app: re-exchange at expires_in − 60 s, or on 401 token_expired, with a fresh access token
```

## Endpoints
- `POST /api/auth/exchange` → 200 `{agent_token, expires_in, user, firm, seat, cap}`; 401
  `invalid_token` / `invalid_app_key`; 403 `no_seat` (`seat: none|suspended`) / `firm_inactive`;
  503 `auth_unavailable` / `entitlement_unavailable`. Disabled (501) without `AGENT_TOKEN_SECRET`.
- `POST /api/auth/logout` — revokes the `jti`, drops the vaulted token.
- A removed user keeps chatting for at most the token's lifetime; wire your admin backend to
  revoke on removal (`revokeUser`) for immediate effect.

## Entitlement contract
`GET AGENT_ENTITLEMENT_URL/{firm_id}/{sub}` with `AGENT_ENTITLEMENT_KEY` →
```json
{ "seat": "active|none|suspended", "plan": "pro",
  "cap": { "credits": 400, "period": "month", "resets_at": "2026-11-01T00:00:00+05:30" },
  "firm_status": "active|past_due" }
```
Decided defaults: unseated users are refused at exchange (no trial); caps per seat per
calendar month with a daily ceiling of 10% of the month; the user sees a percent; over cap ⇒
429 `usage_cap` with `scope` and `resets_at`. Account identity for metering:
`account_id = <tenant>:<sub>`, parent = firm — opaque, so it can move to another identity platform.

## Expiry mid-turn
If your API answers 401 inside a turn, the gateway ends the turn with `token_expired`,
`retryable: true`; the native side re-exchanges and the client resends the message once. Reads
are harmless; the one write is idempotent (session + draft fingerprint).

## The web-view host (what the first integration measured)
A web-view host of the widget was GO on Android: tap-to-interactive 0.7–0.9 s in a warm process,
~2.6 s on a first-ever web view in an install, +80–90 MB; keep the widget script compressed and
versioned, give the host page a CSP and a navigation allowlist, and bridge photo picking and the
microphone natively. The widget's `opts.token` accepts an async function so a renewed token
applies on the next request.


---

<small>Source: <a href="https://github.com/marg-adk/marg/blob/main/docs/SDK-AUTH.md">docs/SDK-AUTH.md</a> — edit it there; the site mirrors the repository.</small>
