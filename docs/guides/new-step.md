# Guide: a new runtime-owned step

Ask first: **what does a wrong answer cost?** A guessed value published under the user's name,
a skipped question, a write without a yes — those are steps. Free text, digressions and
corrections in words stay the model's.

## The three helpers (`stepHelpers` from `@marg/core`)

```ts
import { stepHelpers, type StepDefinition } from "@marg/core";
const { chipsStep, multiStep, formStep } = stepHelpers;

export const steps: StepDefinition[] = [
  chipsStep({ key: "priority", label: "Priority", slot: "priority", lead: "How urgent is this?",
    options: async (ctx) => ctx.json(await ctx.call("reference_data", { kind: "priorities" }))?.options.map((v: string) => ({ label: v, value: v })),
    say: "Priority set to {v}.", asksLike: /\b(priority|urgent)\b/i, dependsOn: ["details"] }),
  multiStep({ key: "features", label: "Key features", slot: "features", lead: "Pick at least 3:", min: 3, own: { max: 30 }, options: [...] }),
  formStep({ key: "details", label: "Details", lead: "A few details:", rows: [{ key: "env", label: "Environment", kind: "pick", required: true, options: [...] }], check: (v) => ({}) }),
];
```

## The raw interface
Implement `StepDefinition` when the moment is bespoke (a picker fed by a search, a two-stage
ask, a computed verdict):

- `applies(ctx)` — does the step exist for this draft (a rent-only card)?
- `owed(ctx)` — is it due now? Default: every earlier step ended and the draft is valid.
- `draw(ctx, via)` — the lead line + blocks; store scratch in `state`; give the model a `note`.
- `read(ctx, message)` — by the WHOLE content: `settle` (values), `skip`, `redraw` (a partial
  form with errors), or `words` (the model answers; the engine redraws the ask).
- `settle(ctx, read, via)` — write `slots`, say one line, give the model a fact.
- `owns` — the slot keys the carry rule restores into every validate/preview/create call.
- `asksLike` — the model's own sentence that asks this question (cut from its reply).
- `dependsOn` — steps whose change re-opens this one.
- `optional`, `still`, `identityKey`.

## Rules that keep a step honest
- Read by the whole content; anything you cannot read is `words`, never a guess.
- Carry what settled; the model's value for an owned slot never stands.
- Say what settled in one line; tell the model in one fact; never enumerate upcoming steps.
- Emit counts and enums only in telemetry — never the user's text.
- Add scenarios: the draw, a settle, words beside the open ask (and the reload redraw), a
  partial submit, the review re-open, a dependency reset.
