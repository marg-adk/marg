# ADR 0004 — The runtime owns the moments that must be right

- **Status:** Accepted
- **Date:** 2026-10-02 → 2026-10-11 (eighteen journey items in the first vertical), restated 2026-10-13

## Context
With the whole journey model-led, measured over hundreds of chats: a required question was
skipped 25–50% of the time depending on the run; a list published under the user's name was
invented 1 in 64 chats even with a model-specific note; a model attested `confirmed:true`
after the user sent a change; a correction was recorded without acknowledgement; a fetched
record slid silently into the summary. Prompt rules moved these rates; none reached zero,
and each model slipped somewhere else.

## Decision
The model owns the conversation; the runtime owns the moments that must be right. A **step**
is such a moment: the runtime draws it (a form, chips, a picker), reads the reply in code by
its whole content, writes the draft, carries the values into every tool call, and tells the
model one fact. A settle chains into the next owed step or the confirmation summary in the
same reply; an owed step is late-drawn under a model turn with the model's own question cut;
words beside an open ask go to the model and the ask is redrawn under the answer; a reload
redraws the open ask; the review re-opens a step's own card and returns to the summary;
dependencies re-ask what a change invalidates. Steps are data on the manifest (per type) and
code in the domain (`steps/index.ts`) built from three helpers or the raw interface.

## Rejected
- "Stricter prompts": measured, insufficient, model-specific.
- "Validate after the fact only": the wrong value had already been shown and confirmed.
- "A form instead of a chat": loses the conversational gathering that the model does well.

## Consequences
Runtime turns cost no tokens and are deterministic — evals pin them exactly; the model's
prompt gets a short block of runtime facts per turn (cache-stable prefix, varying tail); every
step reports a behaviour event (counts and enums only). The eval runner must answer runtime
asks it did not script (it does: `tap`, `submitForm`).


---

<small>Source: <a href="https://github.com/marg-adk/marg/blob/main/docs/adr/0004-runtime-owned-steps.md">docs/adr/0004-runtime-owned-steps.md</a> — edit it there; the site mirrors the repository.</small>
