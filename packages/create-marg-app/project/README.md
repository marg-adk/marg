# __NAME__

A [Marg](https://github.com/marg-adk/marg) agent: a conversational agent that takes a person
from a first sentence to a completed action against a real backend.

```bash
npm install
npm run gateway          # http://localhost:8787 — the playground
```

Type **"ticket for Northwind: login fails on mobile"**: the example domain (`examples/support-intake`)
runs end to end on the scripted mock model in `.env` (`LLM_CHAIN=mock`, no key). Switch to a real
model by editing one line there.

## Your own domain

```bash
npx marg new bookings --entity booking     # domains/bookings from templates/
```

Build in this order: tools (`mcp/server.ts`) → probe the backend → schema registry → skill →
runtime-owned steps → mock policy → evals. The example is the reference for every part; the
guide is at https://github.com/marg-adk/marg/blob/main/docs/guides/new-domain.md.

## The gate

```bash
npx marg check           # typecheck, then every suite against its own writes-off gateway
```

Or by hand: `npm run gateway:evals &` (a second gateway on :8788, writes off), then `npm run evals`.

## Layout

| Folder | What |
|---|---|
| `domains/` | your domains (discovered at boot) |
| `examples/support-intake/` | the reference domain: manifest, tools, skill, schema, steps, mock, evals |
| `templates/` | what `npm run new-domain` copies |
| `shared-skills/` | conversation behaviour and visual presentation, injected into every domain |
| `skills/build-a-domain/` | the method for a coding agent (Claude Code loads it from `.claude/skills/`; `AGENTS.md` for others) |
| `.env` | every setting, documented at https://github.com/marg-adk/marg/blob/main/docs/ENVIRONMENT.md |
