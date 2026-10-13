#!/usr/bin/env bash
# scripts/rename.sh — make it yours: rename the brand, the npm scope and the storage key.
#
#   scripts/rename.sh "Acme Agent" acme
#
# Replaces  Marg → "Acme Agent"  (display name, AGENT_BRAND default, titles)
#           @marg/* → @acme/*    (package scope, tsconfig paths, imports)
#           marg → acme          (slugs: package name, storage key marg:sid:, docs)
# in every text file except LICENSE, CHANGELOG.md, package-lock.json, node_modules, .git and
# .data, then re-links the workspaces. Workspace FOLDERS keep their names. The Hindi word and
# the name rationale in README.md are yours to rewrite by hand. Review with `git diff --stat`.
set -euo pipefail
NEW_TITLE="${1:-}"
NEW_SLUG="${2:-}"
if [[ -z "$NEW_TITLE" || -z "$NEW_SLUG" ]]; then
  echo 'usage: scripts/rename.sh "<Display name>" <slug>' >&2
  exit 2
fi
if ! [[ "$NEW_SLUG" =~ ^[a-z][a-z0-9-]*$ ]]; then
  echo "slug must be kebab-case (a-z, 0-9, -)" >&2
  exit 2
fi
cd "$(dirname "$0")/.."
FILES=$(grep -rIl --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.data --exclude-dir=results \
  --exclude=package-lock.json --exclude=LICENSE --exclude=CHANGELOG.md --exclude=rename.sh -e 'marg' -e 'Marg' . || true)
if [[ -z "$FILES" ]]; then
  echo "nothing to rename"
  exit 0
fi
COUNT=0
while IFS= read -r f; do
  NT="$NEW_TITLE" NS="$NEW_SLUG" perl -pi -e '
    s/\@marg\//\@$ENV{NS}\//g;
    s/\bmarg-adk\b/$ENV{NS}-adk/g;
    s/\bmarg:sid:/$ENV{NS}:sid:/g;
    s/\bMarg\b/$ENV{NT}/g;
    s/\bmarg\b/$ENV{NS}/g;
  ' "$f"
  COUNT=$((COUNT + 1))
done <<< "$FILES"
rm -rf node_modules/@marg
npm install --no-audit --no-fund >/dev/null
echo "renamed in $COUNT files → ${NEW_TITLE} (@${NEW_SLUG}/*). Review: git diff --stat"
