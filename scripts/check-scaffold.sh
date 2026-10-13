#!/usr/bin/env bash
# scripts/check-scaffold.sh — proves the templates: scaffold a domain, typecheck it, boot a gateway
# with ONLY that domain (mock model, writes off) and run the scaffold's own eval suite. Cleans up.
#   npm run check:scaffold          (SCAFFOLD_PORT=8790 by default)
set -euo pipefail
cd "$(dirname "$0")/.."
NAME=scaffold-check
PORT=${SCAFFOLD_PORT:-8790}
GW=""
cleanup() {
  if [[ -n "$GW" ]]; then kill "$GW" 2>/dev/null || true; fi
  rm -rf "domains/$NAME"
}
trap cleanup EXIT
rm -rf "domains/$NAME"
npm run -s new-domain -- "$NAME" --entity booking > /dev/null
npm run -s typecheck
mkdir -p .data
AGENT_SESSION_DIR=.data/sessions-scaffold AGENT_ALLOW_WRITES=false AGENT_REQUIRE_LOGIN=false AGENT_RATE_DISABLED=true LLM_CHAIN=mock GATEWAY_PORT="$PORT" AGENT_DOMAINS="$NAME" \
  npx tsx packages/gateway/src/server.ts > .data/gw-scaffold.log 2>&1 &
GW=$!
for _ in $(seq 1 60); do
  curl -fsS "http://localhost:$PORT/api/health" > /dev/null 2>&1 && break
  sleep 1
done
if ! curl -fsS "http://localhost:$PORT/api/health" > /dev/null; then
  echo "the scaffold gateway did not come up:"
  tail -n 40 .data/gw-scaffold.log
  exit 1
fi
EVAL_GATEWAY="http://localhost:$PORT" npx tsx "domains/$NAME/evals/run-evals.ts"
