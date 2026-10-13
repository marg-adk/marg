# Guide: evals

```bash
npm run gateway:evals &      # writes OFF, login off, rate limits off, :8788
npm run evals                # the example suite — 7 scenarios in seconds on the mock
SCENARIO=review-edit EVAL_VERBOSE=true npm run evals
EVAL_SHARD=0/3 npm run evals  # with one gateway per shard
EVAL_RERUNS=1 EVAL_FLAKES=price-magnitude npm run evals   # against a real model
```

## Writing a scenario
```ts
{
  id: "review-edit", goal: "Change something → Priority re-opens → summary returns",
  turns: [
    { send: "ticket for Tailspin: checkout button greyed out", checks: [noError] },
    { send: tap("Technical"), checks: [hasUi("form", { step: "details" }), reloadRedraws("form")] },
    { send: submitForm({ environment: "production", steps_to_reproduce: "…" }), display: "Details confirmed: Production", checks: [runtimeTurn("details")] },
    { send: tap("Medium"), checks: [hasUi("card"), stepStatus("priority", "settled")] },
    { send: tap("Change something"), checks: [runtimeTurn("edit"), hasUi("chips", { step: "edit" })] },
  ],
  finalChecks: [neverTool("create_ticket")],
}
```
`tap(label)` and `submitForm(values)` read the LAST turn's blocks, so the scenario follows
what the runtime actually drew. `creates: true` marks a scenario that ends in a write; it runs
only against a gateway whose health says writes are off.

## Combinators
`noError`, `replyMatches`, `replyNotMatches`, `replyOrUiMatches`, `hasUi(type, tags)`,
`noUi`, `toolCalled`, `toolCalledThisTurn`, `neverTool`, `neverToolThisTurn`,
`runtimeTurn(kind)`, `modelTurn`, `draftHas(slot, re)`, `draftState`, `stepStatus`,
`completed`, `notCompleted`, `reloadRedraws(type)`, `oneQuestion`, `noLeak(re)`.
A refused write shows in the trace as `create_x (refused)` — assert on it explicitly.

## The gate report
`✅ PASS · 🟡 FLAKE (green on rerun or in the ledger) · 🟠 TRANSPORT (429 / outage / "briefly
unavailable") · ❌ FAIL`. The exit code is 0 only with no FAIL and no TRANSPORT. Results and
full transcripts land in `evals/results/<timestamp>/`.

## Against a real model
Expect variance: run three times and compare failing SETS. Keep 2–3 shards. Send
`X-Agent-Eval` (the runner does) so eval traffic is one filter away from production on every
panel. Keep a flake ledger and a clean-baseline worktree for classification.
