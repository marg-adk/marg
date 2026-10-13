# CLAUDE.md — working on Marg

Standing context for any Claude Code session in this repository. Keep it short; link out.

## What this is
An open-source Agent Development Kit (TypeScript, Node ≥ 22, npm workspaces, runs with `tsx`,
no build). Read `docs/PATTERN.md` first in any session that touches architecture; `docs/PLAYBOOK.md`
for how work is done; `ROADMAP.md` for what is next.

## The design in two lines
Within a domain, compose skills; across domains, delegate through the super agent (ADR-0001).
The model owns the conversation; the runtime owns the moments that must be right (ADR-0004).

## The gate (run before and after any change that touches a reader, a guard, a step, a skill or the widget)
```bash
npm run lint && npm run typecheck && npm test && npm run check:otel && npm run check:scaffold && npm run check:e2e
npm run gateway:evals &   # writes OFF on :8788
npm run evals             # the example suite must stay green
```
Classify every red before fixing it: check brittleness, model flake, pre-existing, transport, regression.

## Conventions
- File headers say what the file is, what comes in and out, who talks to it. Guard code cites the
  incident it stops.
- Commits: `Topic: imperative summary`. One branch per change.
- No product, brand or company specifics in `packages/`, `docs/` or `templates/`: everything
  product-specific lives in a domain folder, a shared skill or the environment.
- Telemetry labels are counts and enums, never a user's text. Done = visible on a panel.
- The create gate exists three times and never weakens. `AGENT_ALLOW_WRITES` must equal the
  literal `"true"`; evals and CI run with writes off.
- The user's token rides MCP `_meta`, never tool arguments, never persistence.

## Where things are
- Runtime: `packages/core/src` (steps in `steps/`, readers in `reply-words.ts` + `readers.ts`,
  guards in `guards.ts`, the review picker in `sections.ts`).
- Decisions: `packages/verdict/src`. Gateway: `packages/gateway/src`. Client: `packages/widget`.
- The example domain: `examples/support-intake`. Scaffolding: `templates/`, `scripts/new-domain.ts`.
- Checks: `scripts/check-*.{ts,sh}`. Observability as code: `observability/openobserve/`.
- The site: `website/` (VitePress; `sync.mjs` mirrors docs/ into `website/src` with links rewritten;
  authored pages in `website/pages`; `npm run site:build`; deployed by `.github/workflows/pages.yml`).
- The CLI: `packages/marg` (`marg web|new|evals|verdict|check`, plain JS, templates synced into
  its payload at build). Projects from create-marg-app use it; the repository keeps its npm scripts.
- Publishing: `scripts/build.ts` (dist per package, in dependency order), `packages/create-marg-app`
  (its `payload/` is synced from templates, the example, shared skills at build), `check:pack`,
  `check:create`, `.github/workflows/release.yml` (tag `v*` → npm, needs `NPM_TOKEN`). Development
  never needs the build: tsx runs the sources through `tsconfig.json` paths.

## Current focus
`ROADMAP.md` → "0.2 — the adoption push", items 1 to 7, in that order; start with item 1
(publishable packages and `create-marg-app`). Each item names its acceptance test; run the gate
before and after. Nothing lands that breaks `check:scaffold` or the example suite. This repository
was built in one long session and handed over through its files: everything a session needs is in
`CLAUDE.md`, `ROADMAP.md` and `docs/`, not in anyone's memory.

## Environment
`npm install`, `cp .env.example .env` (the mock model; no key), `npm run gateway` → :8787.
Optional: `docker compose -f observability/docker-compose.yml up -d` for OpenObserve.
