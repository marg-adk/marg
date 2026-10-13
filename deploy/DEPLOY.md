# Deploying a Marg gateway

One stateless Node process (no build step), behind TLS, with four optional profiles. The
production checklist in `docs/PRODUCTION-CHECKLIST.md` is the gate; this file is the mechanics.

## With Docker Compose
```bash
cp .env.production.example .env.production        # fill it: model, identity, secrets, origins
docker compose -f deploy/docker-compose.yml --env-file .env.production \
  --profile stores --profile observability --profile edge up -d --build
curl -fsS https://$AGENT_DOMAIN/api/health          # chain state, stores, writes flag, version
npm run o2:bootstrap                                # dashboards + alerts into OpenObserve (AGENT_O2_* from .env.production)
```
Profiles: `stores` (Redis + Mongo — sessions, ledgers, shared counters), `observability`
(OpenObserve), `decisions` (Ollama with `laya` for Verdict's System One backend), `edge` (Caddy
with automatic TLS for `AGENT_DOMAIN`). Without `stores` the gateway keeps sessions in memory
with a file fallback under the `gateway-data` volume — fine for one replica, not for two.

## The hosted playground

`render.yaml` at the repository root is a Render Blueprint for the public playground: the same
image on the free tier with `LLM_CHAIN=mock`, writes off, no login and the rate limits on. New →
Blueprint on Render, point it at the repository, done. It sleeps when idle and keeps no disk, so
sessions may be lost; it is a demo, not a deployment.

## Without Docker
```bash
npm ci && cp .env.production.example .env           # the gateway reads .env
NODE_ENV=production npx tsx packages/gateway/src/server.ts
```
Run it under systemd (`Restart=always`, `KillSignal=SIGTERM`, `TimeoutStopSec=40`) behind any
reverse proxy that passes SSE through unbuffered (nginx: `proxy_buffering off;
proxy_read_timeout 600s;`). Set `AGENT_TRUST_PROXY=true` so rate limits see the client IP.

## Operating it
- **Rolling update** — `docker compose … up -d --build gateway`. SIGTERM drains in-flight turns
  for `AGENT_SHUTDOWN_GRACE_MS` (default 10 s); the compose `stop_grace_period` is 40 s.
- **Scaling** — with `stores` on, the gateway is stateless: run N replicas behind the edge;
  rate limits and caps are shared through Redis.
- **Health** — `GET /api/health`: model chain and breaker state, stores, writes flag, otel.
  Alert on it, and on the error-ratio alert that `o2:bootstrap` installs.
- **Backups** — the volumes `mongo-data`, `redis-data`, `gateway-data` (uploads and the file
  fallback), `o2-data`.
- **Secrets** — `.env.production` only; nothing in the image. Rotate `AGENT_TOKEN_SECRET` by
  restarting with a new value (agent tokens live `AGENT_TOKEN_TTL_S`, default 15 min).
- **Logs** — structured JSON on stdout (`docker logs`), shipped to OpenObserve when
  `AGENT_O2_URL` is set, with the trace id on every line.
- **Kubernetes** — the same image; readiness and liveness on `/api/health`;
  `terminationGracePeriodSeconds: 40`; env from a Secret.

## Before the first real user
Run the checklist: `docs/PRODUCTION-CHECKLIST.md`. The short version — a real model chain
(`LLM_CHAIN` ≠ mock), `AGENT_REQUIRE_LOGIN=true` with `AGENT_AUTH_VERIFY_URL`, `AGENT_TOKEN_SECRET`,
`AGENT_ADMIN_KEY`, `AGENT_CORS_ORIGINS` set, the write probe run against the real backend, the
eval suite green against the real chain, and every panel in OpenObserve showing data.
