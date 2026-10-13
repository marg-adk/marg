# ADR 0001 — Domains and routing: compose within, delegate across

- **Status:** Accepted
- **Date:** 2026-08-09 (origin), restated for Marg 2026-10-13
- **Deciders:** the first vertical's owner. Drafted with Claude Code.

## 1. Context
A single agent that did one job well (a system prompt that concatenated every skill, one MCP
server with 13 tools) was to become a super agent with sibling capabilities (tasks, leads,
matching). The question: how do these share one user-facing agent without the prompt and the
tool list growing unbounded, and what package shape does each capability take?

## 2. Decision drivers
1. Context budget and tool-selection accuracy (more tools + skills in one prompt = worse choices, higher cost).
2. Guardrail isolation (one domain's confirm gate must not dilute in another's turns).
3. Per-domain evals as the regression gate.
4. Independent iteration and deploy.
5. Cross-domain flows must remain possible.
6. Cost controls and multi-tenancy are downstream — the shape must not fight them.

## 3. Options
- **A. Monolithic composition** — one context with every domain's skills and tools. Simplest; no routing; cross-domain free. Does not scale past ~2 domains: tool accuracy degrades, every turn pays for every domain, guardrails blur, evals cannot isolate.
- **B. Delegation** — a thin router picks ONE domain per turn; each domain agent runs in its own context. Bounded context, isolated guardrails and evals, independent deploy. Costs a routing hop and explicit orchestration.
- **C. Hybrid (chosen)** — B across domains, A within: multiple skills per domain stay fine (orchestrator + deltas + shared behaviour); multiple domains in one context, never.

## 4. Decision
Adopt C. The super agent is a router, not a doer: domain cards from the manifests, one domain
per turn, sticky (stay until intent clearly shifts; never re-route mid-journey or after
completion), fallback chain matched → active → first — routing never throws, a misroute
degrades to a clarifying question, never a wrong write. Single domain ⇒ no classification.
Cross-domain flows are sequenced by the super agent; domains stay unaware of each other; a
domain that needs another's data gets a shared READ-only tool, never a write.

**One line:** *within a domain, compose skills; across domains, delegate through the super agent.*

## 5. The convention
A domain is a self-contained folder: `domain.json` (name, title, description = the router
card, route hints, mcp, skills, shared skills, types, steps, evals), `skills/`, `mcp/`,
`schema/`, `steps/`, `mock/`, `probe/`, `evals/`. Discovery globs the manifests at boot; a
broken one is skipped, never fatal. Shared skills (behaviour, visual protocol) are injected
into every domain agent.

## 6. Consequences
- Context per turn stays the size of one domain regardless of how many exist.
- The routing hop is a typed decision (ADR-0005) — keywords free, a decision model cheap, the LLM last.
- Agent-as-tool (one domain calling another) is deliberately deferred.
