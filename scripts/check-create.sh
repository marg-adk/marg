#!/usr/bin/env bash
# scripts/check-create.sh — the acceptance test of create-marg-app, with nothing published:
# builds, packs every package into tarballs, creates a project from them in a temp folder,
# installs it, boots its gateway (writes off) and runs the example suite against it. Cleans up.
#   npm run check:create          (CREATE_PORT=8792 by default; KEEP_CREATE=1 keeps the folder)
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=${CREATE_PORT:-8792}
TMP=$(mktemp -d "${TMPDIR:-/tmp}/marg-create.XXXXXX")
GW=""
cleanup() {
  if [[ -n "$GW" ]]; then kill "$GW" 2>/dev/null || true; fi
  if [[ -z "${KEEP_CREATE:-}" ]]; then rm -rf "$TMP"; else echo "kept: $TMP"; fi
}
trap cleanup EXIT
npm run -s build
mkdir -p "$TMP/packs"
for w in @marg/types @marg/core @marg/verdict @marg/evals @marg/metering @marg/widget @marg/gateway; do
  npm pack -s -w "$w" --pack-destination "$TMP/packs" > /dev/null
done
ls "$TMP/packs"
(cd "$TMP" && CREATE_MARG_APP_PACKS="$TMP/packs" node "$OLDPWD/packages/create-marg-app/bin/create-marg-app.js" demo)
cd "$TMP/demo"
npm install --no-audit --no-fund --loglevel=error
npm run -s typecheck
echo "demo: typecheck clean"
AGENT_ALLOW_WRITES=false AGENT_REQUIRE_LOGIN=false AGENT_RATE_DISABLED=true GATEWAY_PORT="$PORT" npm run -s gateway > gateway.log 2>&1 &
GW=$!
for _ in $(seq 1 60); do
  curl -fsS "http://localhost:$PORT/api/health" > /dev/null 2>&1 && break
  sleep 1
done
if ! curl -fsS "http://localhost:$PORT/api/health" > /dev/null; then
  echo "the demo gateway did not come up:"; tail -n 40 gateway.log; exit 1
fi
curl -fsS "http://localhost:$PORT/api/health"; echo
curl -fsS "http://localhost:$PORT/" | grep -q "widget.js" || { echo "the playground page did not render"; exit 1; }
bytes=$(curl -fsS "http://localhost:$PORT/widget.js" | wc -c | tr -d " ")
[[ "$bytes" -gt 10000 ]] || { echo "widget.js not served (got $bytes bytes)"; exit 1; }
echo "demo: playground and widget served on :$PORT"
EVAL_GATEWAY="http://localhost:$PORT" npm run -s evals
echo "create-marg-app OK: install, typecheck, gateway, playground, example suite"
