# ADR 0005 — Typed decisions through a cascade; Laya as the embedded decision model

- **Status:** Accepted
- **Date:** 2026-10-13

## Context
Routing used a cheap generative model (a one-word classification); readers used
hand-written rules; some safety checks were prompt rules. A hosted "decision model" API
(Jev, TypeSafe AI) showed the shape that fits: typed questions answered with calibrated
probabilities in one forward pass. It is proprietary and metered per token. Laya
(Convai Innovations, Apache-2.0) is an open-weight model that speaks the same System One
protocol, with published parity on the typed-decisions benchmark.

## Decision
- A typed-decision interface (`choice`, `noul`, `score` → distributions) with pluggable
  backends and a cascade: rules → System One server (Laya via Ollama/laya-serve, or Jev) →
  LLM with logprobs. The agent never knows which link answered; `answered_by` is on the result.
- Laya is the embedded open-source decision model: a compose profile pulls it; the CLI, the
  MCP server and the runtime's router use it when `VERDICT_SYSTEMONE_URL` is set.
- The kit also SERVES the protocol (`createSystemOneServer`) so a rules + LLM cascade can
  stand in for a decision model behind the same URL.
- Confidence is derived uniformly (distribution concentration; |2p−1|) so links compare;
  calibration (temperature, ECE, abstention threshold) is measured on the operator's own data.
- The create gate stays rules-only; a decision model may advise a reader on the model-handoff
  path, never loosen a gate where a false yes performs a write.

## Consequences
Routing costs nothing with keywords, ~30 ms with Laya, one short model call only as a last
resort. The vendor dependency is optional and replaceable by anything that speaks the protocol.


---

<small>Source: <a href="https://github.com/marg-adk/marg/blob/main/docs/adr/0005-typed-decisions.md">docs/adr/0005-typed-decisions.md</a> — edit it there; the site mirrors the repository.</small>
