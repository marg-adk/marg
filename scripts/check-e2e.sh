#!/usr/bin/env bash
# scripts/check-e2e.sh — boots a gateway with WRITES ON for the example domain (mock model, its
# JSON-file backend) on :8791, runs scripts/check-e2e.ts against it, and stops it.
#   npm run check:e2e        (E2E_PORT=8791 by default)
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=${E2E_PORT:-8791}
GW=""
cleanup() { if [[ -n "$GW" ]]; then kill "$GW" 2>/dev/null || true; fi; }
trap cleanup EXIT
mkdir -p .data
AGENT_SESSION_DIR=.data/sessions-e2e AGENT_ALLOW_WRITES=true AGENT_REQUIRE_LOGIN=false AGENT_RATE_DISABLED=true LLM_CHAIN=mock GATEWAY_PORT="$PORT" AGENT_DOMAINS=support-intake \
  npx tsx packages/gateway/src/server.ts > .data/gw-e2e.log 2>&1 &
GW=$!
for _ in $(seq 1 60); do
  curl -fsS "http://localhost:$PORT/api/health" > /dev/null 2>&1 && break
  sleep 1
done
if ! curl -fsS "http://localhost:$PORT/api/health" > /dev/null; then
  echo "the e2e gateway did not come up:"
  tail -n 40 .data/gw-e2e.log
  exit 1
fi
EVAL_GATEWAY="http://localhost:$PORT" npx tsx scripts/check-e2e.ts
