#!/usr/bin/env bash
# scripts/check-scaffold.sh — proves the templates: scaffold a domain, typecheck it, boot a gateway
# with ONLY that domain (mock model, writes off) and run the scaffold's own eval suite. Cleans up.
#   npm run check:scaffold                         (SCAFFOLD_PORT=8790 by default)
#   SCAFFOLD_LANG=python npm run check:scaffold    the Python tool server: a venv under .data/ with
#                                                  mcp/requirements.txt, a syntax check, the same gateway and suite
set -euo pipefail
cd "$(dirname "$0")/.."
NAME=scaffold-check
PORT=${SCAFFOLD_PORT:-8790}
LANG_=${SCAFFOLD_LANG:-ts}
GW=""
cleanup() {
  if [[ -n "$GW" ]]; then kill "$GW" 2>/dev/null || true; fi
  rm -rf "domains/$NAME"
}
trap cleanup EXIT
rm -rf "domains/$NAME"
npm run -s new-domain -- "$NAME" --entity booking --lang "$LANG_" > /dev/null
npm run -s typecheck
mkdir -p .data
if [[ "$LANG_" == "python" ]]; then
  # The manifest runs `python3`; a venv first on PATH makes that the interpreter with the SDK installed.
  PY=${SCAFFOLD_PYTHON:-python3}
  "$PY" -m venv .data/venv-scaffold
  .data/venv-scaffold/bin/python -m pip install -q --disable-pip-version-check -r "domains/$NAME/mcp/requirements.txt"
  .data/venv-scaffold/bin/python -m py_compile "domains/$NAME/mcp/server.py"
  export PATH="$PWD/.data/venv-scaffold/bin:$PATH"
  echo "python: $(python3 --version) with mcp $(python3 -c 'import importlib.metadata as m; print(m.version("mcp"))')"
fi
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
