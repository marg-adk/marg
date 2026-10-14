#!/usr/bin/env bash
# scripts/publish-first.sh — the ONE-TIME publish of a new package by hand, with your 2FA.
# npm's trusted publishing (what release.yml uses) is configured on an existing package, so a
# package's first version goes out from a maintainer's machine: npm login, then this. Later
# versions are CI's. Nothing here needs or stores a token.
#   npm login                      # once, as the npm user in the marg-adk org (2FA on)
#   bash scripts/publish-first.sh  # builds, packs, publishes the nine packages in dependency order
set -euo pipefail
cd "$(dirname "$0")/.."
npm whoami > /dev/null 2>&1 || { echo "not logged in to npm — run: npm login"; exit 1; }
echo "publishing as $(npm whoami) — version $(node -p "require('./package.json').version")"
npm run -s check:pack
for w in @marg-adk/types @marg-adk/core @marg-adk/verdict @marg-adk/evals @marg-adk/metering @marg-adk/widget @marg-adk/gateway marg create-marg-app; do
  if npm view "$w@$(node -p "require('./package.json').version")" version > /dev/null 2>&1; then echo "skip  $w — this version is already on npm"; continue; fi
  echo "▶ npm publish $w (npm will ask for your one-time code)"
  npm publish --access public --provenance=false -w "$w"
done
echo
echo "done. Next, on npmjs.com for EACH package: Settings → Trusted publishing → GitHub Actions →"
echo "  Organization: marg-adk · Repository: marg · Workflow: release.yml · allow: npm publish"
echo "then cut the next version from CI within 2 days (the first CI publish validates the setting)."
