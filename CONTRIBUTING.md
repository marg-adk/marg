# Contributing

Thanks for helping. Marg is a design pattern as much as code; contributions that keep the
pattern honest are the most valuable ones.

## Before you start
- Read `docs/PATTERN.md` and `docs/PLAYBOOK.md`.
- `npm install && cp .env.example .env && npm run gateway` — the playground must run for you
  with no key (`LLM_CHAIN=mock`).

## The gate for every change
```bash
npm run typecheck
npm test                         # unit tests (core, verdict, metering, the widget under a fake DOM)
npm run check:otel               # the OpenTelemetry seam
npm run check:scaffold           # the templates still produce a domain that compiles and passes its suite
npm run check:e2e                # the real write path (writes ON against the example's file backend)
npm run check:pack               # every package builds and packs clean (touch a package.json or a build config)
npm run check:create             # a create-marg-app project from local tarballs installs, boots and passes its suite
npm run gateway:evals &          # writes off, :8788
npm run evals                    # the example suite must stay green
```
A change to a reader, a guard or a step also runs a mutation pass (break the rule in a scratch
copy; the suite must go red) and adds the scenario that would have caught the bug.

## Conventions
- **File headers**: what this is, what comes in and out, who talks to it. Guard code cites the
  incident it stops (with a date) — in the shipped code those are real incidents.
- **Commits**: `Topic: imperative summary (#tag)`; one branch per change; a PR describes the
  gate it ran and classifies every red (check brittleness / flake / pre-existing / regression).
- **Observability is a definition of done**: a new request-side code path ships with a span,
  a logged failure with the trace id, a counter or behaviour event, and `check:otel` green.
- **No product in the runtime**: brand, vocabulary and backend specifics live in domains,
  shared skills and environment — never in `packages/core` or `packages/gateway`.
- **Privacy**: counts and enums in telemetry labels, never a user's text; no PII in ledgers;
  redaction for anything that looks like a token.
- **Never weaken** the write gate, the owner checks, the fail-closed identity verification or
  the link scheme allowlist. A PR that does is closed with a pointer here.

## Adding a backend or a provider
Model endpoints: a preset in `packages/core/src/llm.ts` (base URL, auth style, defaults) and a
price-table entry. Decision backends: implement `DecisionBackend` in `packages/verdict`.
Speech-to-text: a provider branch in `packages/gateway/src/transcribe.ts`.

## Reporting a vulnerability
See `SECURITY.md`. Please do not open a public issue for a security problem.
