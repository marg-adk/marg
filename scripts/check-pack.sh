#!/usr/bin/env bash
# scripts/check-pack.sh — proves every publishable package packs clean: builds, then
# `npm pack --dry-run --json` per package and asserts the entry points, LICENSE and README are
# in the tarball. Nothing is published.
#   npm run check:pack
set -euo pipefail
cd "$(dirname "$0")/.."
npm run -s build
PACKAGES="@marg-adk/types @marg-adk/core @marg-adk/verdict @marg-adk/evals @marg-adk/metering @marg-adk/widget @marg-adk/gateway marg create-marg-app"
fail=0
for w in $PACKAGES; do
  case "$w" in
    @marg-adk/widget) want="widget.js" ;;
    @marg-adk/gateway) want="dist/server.js bin/marg-gateway.js public/demo.html" ;;
    marg) want="bin/marg.js lib/cli.js payload/templates/domain.json.template" ;;
    create-marg-app) want="bin/create-marg-app.js payload/templates/domain.json.template payload/examples/support-intake/domain.json payload/shared-skills/conversation-behaviour/SKILL.md payload/scripts/new-domain.ts payload/env.example project/tsconfig.json" ;;
    @marg-adk/core) want="dist/index.js dist/index.d.ts dist/log-worker.mjs" ;;
    *) want="dist/index.js dist/index.d.ts" ;;
  esac
  if ! json=$(npm pack --dry-run --json --ignore-scripts --loglevel=error -w "$w" 2>&1); then
    echo "FAIL  $w: npm pack exited non-zero"; echo "$json" | tail -20; fail=1; continue
  fi
  verdict=$(WANT="$want LICENSE README.md package.json" node -e '
    const [p] = JSON.parse(require("fs").readFileSync(0, "utf8").replace(/^[^\[]*/, ""));
    const have = new Set(p.files.map((f) => f.path));
    const missing = process.env.WANT.split(" ").filter((f) => !have.has(f));
    const stray = [...have].filter((f) => /(^|\/)(\.env$|\.DS_Store|node_modules\/|results\/|.*\.test\.ts$|tsconfig\.build\.json)/.test(f));
    if (missing.length) console.log("FAIL  missing: " + missing.join(", "));
    else if (stray.length) console.log("FAIL  must not ship: " + stray.join(", "));
    else console.log(`PASS  ${p.entryCount} files, ${(p.unpackedSize / 1024).toFixed(0)} kB unpacked`);
  ' <<<"$json")
  echo "$verdict  — $w"
  [[ "$verdict" == PASS* ]] || fail=1
done
[[ $fail -eq 0 ]] && echo "all packages pack clean" || { echo "pack check failed"; exit 1; }
