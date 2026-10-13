# Typed decisions — Verdict, and Laya as the embedded open-source decision model

## Why a decision engine

An agent makes thousands of judgements that are not prose: which domain handles this message,
is this reply a plain yes, which of these options did the user mean, is it safe to call the
write tool, how severe is this report. Answering them with a generative model is slow,
expensive, verbose and uncalibrated — and routing them through prompt rules is unreliable.

A **typed decision** is a question with a fixed answer shape, answered with a probability
distribution:

| type | question | answer |
|---|---|---|
| `choice` | pick one of named options (`criteria: {key: description}`) | `choice`, `probabilities`, `confidence` |
| `noul` | is this statement true? | `noul` = P(true), `confidence` = \|2p−1\| |
| `score` | which ordinal level? (`criteria: [levels]`) | `score` (expected level), `level`, `probabilities`, `confidence` |

This is the System One protocol (`POST /v1/systemone {state, questions}`), spoken by the
proprietary Jev API and by **Laya**, an open-weight, Apache-2.0 decision model from Convai
Innovations (github.com/NandhaKishorM/laya): ModernBERT-large / mmBERT-base encoders that
answer in a single forward pass (~30 ms per question on a GPU, 100+ languages in the
multilingual checkpoint, a `laya-typed-decisions` checkpoint fine-tuned for agent workflows).

## What @marg-adk/verdict gives you

- **Backends behind one interface**: `rulesBackend` (regex / predicates — free, certain, first),
  `systemOneBackend` (Laya via Ollama or `laya-serve`, or any compatible server), `llmBackend`
  (a generative model answering one letter, with logprobs → a real distribution; a bare letter
  → an honest low-confidence one-hot), `mockBackend` (tests).
- **A cascade**: each question travels down the chain until answered with confidence ≥ the
  threshold; a dead link is skipped and counted; low-confidence earlier answers survive as a
  flagged fallback; `answered_by` says who answered what.
- **A Decider** facade: `choose`, `yesNo`, `score`, `decide`, `decideSchema` (a JSON-schema-like
  object with enums / booleans / bounded integers → values), per-question calibration and
  abstention (`min_confidence` → `low_confidence`, `abstained`).
- **Calibration maths**: temperature scaling with a grid-search fit, accuracy / Brier / ECE and
  the abstention trade-off table, `fitAbstentionThreshold(samples, targetPrecision)`.
- **A System One server** (`createSystemOneServer(backend)`): serve ANY backend over the same
  protocol — tests, air-gapped deployments, a gradual migration from a hosted API.
- **A CLI** (`npm run verdict -- "<text>" --choice dept=a,b,c`) and an **MCP server**
  (`npm run verdict:mcp`) for any agent that speaks MCP.

Inside the runtime, the router asks a `choice` over the domain cards (keywords first, then
the decision model, then the LLM with logprobs), sticky to the active domain.

## Running Laya

```bash
# Ollama (≥ 0.40.0):
ollama pull laya                      # or laya:421m-typed-decisions-mlx-fp16 / laya:322m-multilingual-mlx-fp16
export VERDICT_SYSTEMONE_URL=http://localhost:11434 VERDICT_SYSTEMONE_MODEL=laya

# or the Python server:
python -m pip install "laya[serve]"
LAYA_PORT=8000 laya-serve             # POST /v1/systemone, /v1/systemone/batch, GET /models
export VERDICT_SYSTEMONE_URL=http://localhost:8000
```
`docker compose -f deploy/docker-compose.yml --profile decisions up -d` starts an Ollama
service and pulls the model.

Limits to design around: `choice` / `score` take 2–26 options (about 20 recommended — the
published Banking77 score of 0.43 on 77 options is the reason); each question has a ~512-token
budget shared by instructions, options and state (1024 on the typed-decisions and multilingual
checkpoints); request bodies up to 64 KiB; batch up to 64 states. Published figures (the
authors' own measurements, T4 GPU): typed-decisions benchmark 0.766 vs 0.727 for the hosted
API, ECE 0.081, ~33 ms per question. Verify on your data.

## Calibrate before you trust a threshold

Confidence is a property of the distribution, not the chance of being right. Build a labelled
set from your own traffic (a few hundred decisions), run `evaluate()`, fit a temperature,
choose the threshold that reaches the precision you need, and store it per question id in the
Decider's `calibration`. Re-run when the model, the options or the traffic change.

## Where NOT to use it

The create gate reads a yes by its whole content with rules only. A decision model may advise a
reader on the model-handoff path; it must never loosen a gate where a false yes performs a
write. The cascade's `maxDepth` exists for exactly this.


---

<small>Source: <a href="https://github.com/marg-adk/marg/blob/main/docs/DECISIONS.md">docs/DECISIONS.md</a> — edit it there; the site mirrors the repository.</small>
