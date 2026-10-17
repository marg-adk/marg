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
`formRow(key, { value, error })`, `cardRow(key, { value })`, `noUi`, `toolCalled`, `toolCalledThisTurn`, `neverTool`, `neverToolThisTurn`,
`runtimeTurn(kind)`, `modelTurn`, `draftHas(slot, re)`, `draftState`, `stepStatus`,
`completed`, `notCompleted`, `reloadRedraws(type)`, `oneQuestion`, `noLeak(re)`.
A refused write shows in the trace as `create_x (refused)` — assert on it explicitly.

### The dev trace
A gateway started with `AGENT_DEV_TRACE=true` (`npm run gateway:evals` does, and a created project's
`.env` does) hands each turn's facts to the runner: `TurnResult.trace` (the route decision, the step
engine's events, every tool call with its arguments and result, the model's calls) and `turns`
(what `GET /history` would let a reload redraw). Checks over them: `hasTrace`,
`routeIs({ domain, by, confidence })`, `stepEvent(step, event)`, `toolCall(tool, { args, result })`
and `reloadKeepsTrace`. The example's `dev-trace` scenario walks the journey with all of them. On a
gateway with the flag off the trace checks go red with the reason in their name: that is the flag
doing its job, not a regression.

## Simulated users

A scenario can hand the user's side to a **simulated user** instead of a turn list: `user` is
asked for the next message given what is on screen (the last reply, the blocks a reload would
redraw, the draft, whether the job completed) until it returns null. The checks are the same
deterministic checks: `everyTurn` applies to every turn, `finalChecks` to the end.

```ts
{
  id: "simulated-user", goal: "…", creates: true, turns: [],
  user: cooperativeUser({
    opener: "ticket for Contoso: the invoice export has been broken since Monday",
    prefer: ["Billing", "High", "Confirm & create ticket"],            // taps, in order of preference
    answers: { environment: "production", steps_to_reproduce: "…" },     // form rows by key
    asides: [{ after: 2, say: "what does environment mean?" }],         // free text beside an open ask
  }),
  everyTurn: [noError, oneQuestion, noLeak(/SKILL\.md/)],
  finalChecks: [toolCalledThisTurn("create_ticket"), notCompleted, replyMatches(/writes are disabled/i)],
}
```

`cooperativeUser` is deterministic, so the scenario runs in CI on the mock model; it covers
what a scripted turn list cannot — the user reacting to whatever the runtime draws. A
**model-played user** is the same `UserSim` shape with `next` asking a model (a persona, a goal,
the view as context); write one where free text beyond a script matters, and run it outside CI
against a real model, with the same checks and the same classification of every red.

## The gate report
`✅ PASS · 🟡 FLAKE (green on rerun or in the ledger) · 🟠 TRANSPORT (429 / outage / "briefly
unavailable") · ❌ FAIL`. The exit code is 0 only with no FAIL and no TRANSPORT. Results and
full transcripts land in `evals/results/<timestamp>/`.

## Against a real model
Expect variance: run three times and compare failing SETS. Keep 2–3 shards. Send
`X-Agent-Eval` (the runner does) so eval traffic is one filter away from production on every
panel. Keep a flake ledger and a clean-baseline worktree for classification.
