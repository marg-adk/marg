# The playbook — how to build a domain, and how to keep it working

The process is as much a part of the pattern as the code. These steps were proven on a
production journey of eighteen features, each gated before merge.

## 1. Build order for a new domain

```
MCP tools  →  probe the real backend  →  schema registry  →  orchestrator skill
           →  runtime-owned steps     →  mock policy (optional)  →  evals
```

Slots designed before probing are rework. The probe builds one known-good payload, creates it,
then re-creates with one field stripped at a time to find the REAL mandatories; it is dev-only,
requires `--yes`, tags its records, cleans up after itself and writes a report that is folded
into the registry as `probe_findings_<date>`.

`npm run new-domain -- <name>` scaffolds the folder from `templates/`.

## 2. Fill the worksheet first

`docs/DOMAIN-WORKSHEET.md`: who the user is, the one flow that must work first, the
irreversible write and what confirms it, what "done" looks like, the upstream API reality
(which base URLs share a database, does the server validate anything, schema warts to preserve,
how reference data is searched, the auth contract for acting as the user), the slot schema and
cascade, the trust surface, the channels.

## 3. Decide what the runtime owns

For every moment ask: what does a wrong answer cost? A guessed value published under the user's
name, a skipped question, a write without a yes — those are runtime steps (forms, chips,
pickers, the summary). Free text, a digression, a correction in words — those are the model's.
Write the step from `stepHelpers` (chips, multi, form) or implement `StepDefinition` directly
(docs/guides/new-step.md). Give it `owns` (the slots it writes), `asksLike` (the model's own
sentence that must be cut), `dependsOn` (what re-opens it), and a `still` line.

## 4. Ship one domain, then add the second

The router is skipped with one domain. Add the second only when the first holds green evals;
that is the moment the router starts earning its keep — and the moment to add route hints and,
if you have one, a decision model.

## 5. Evals are the ratchet

- A scenario is a scripted conversation against a gateway started with writes OFF. Checks
  assert what must ALWAYS hold: tools called or never called, blocks drawn, draft state, step
  state, the reload redraw, no leak. Prefer "reply or ui matches" over "reply matches".
- Coverage every suite keeps: the happy path per variant × purpose; the confirm gate; the
  picker; a mid-flow correction; words beside an open runtime ask (and its redraw on reload); a
  partial form; the review; an injection probe; resume; voice if enabled; routing with ≥2 domains.
- Run before AND after any skill change or refactor. Exit code is the CI gate.
- Classify every red before fixing anything:
  - **check brittleness** → fix the CHECK (a regex that assumed wording);
  - **model flake** → green on a serial rerun; write it in the flake ledger;
  - **pre-existing** → red on a clean baseline worktree too; its own ticket;
  - **transport** → 429s, credit outages; not a result, rerun;
  - **regression** → fix the agent.
- Speed: `EVAL_SHARD=i/n` with one gateway per shard. A mock suite finishes in seconds; against
  a real provider keep to 2–3 shards (6 hit the tokens-per-minute limit). Give the browser check
  to a parallel agent with a complete brief. Never quote hour-scale plans.
- Baseline worktree recipe: `git worktree add --detach ../baseline main`, symlink
  `node_modules`, copy `.env`, start its gateway on another port, run the same scenario on
  both. A red on both is pre-existing.
- Mutation pass before a merge of a reader or a guard: mutate the rule in a scratch copy and
  check the suite goes red. A survivor is a missing check.
- Every-scenario checks: a few invariants applied to EVERY turn of EVERY scenario (the reply is
  clean of fence junk; never asks a field a record filled; one question per turn).

## 6. Observability is a definition of done (ADR-0003)

A PR that adds a code path on the request side ships with: a span (`withSpan("area.verb")`),
the failure path logged with the trace id and a stable `error.type`, a counter / histogram /
`behaviour()` event with low-cardinality labels, a panel when someone will look, and
`npm run check:otel` green. Counts and enums only — never a user's text in a label.

## 7. Conventions that keep sessions productive

- **Issue tags** (`#17`, `#preview`) in commit subjects (`Topic: imperative summary (#tag)`),
  code comments, doc sections and scenario ids. The tag is the join key.
- **File headers**: FILE / WHAT THIS IS / WHAT COMES IN–OUT / WHO TALKS TO IT. Guard code
  cites the incident with a date.
- **Standing context**: a short file (CLAUDE.md / CONTRIBUTING) with how to start services,
  what never to weaken, external asks with owners. It is what makes a fresh session productive
  in minutes.
- **External asks** are numbered with owners; integrations built on unconfirmed contracts are
  marked provisional in code comments.
- **Safe-by-default env**: every hardening feature opt-in (dev = zero config), every write
  flag must equal the literal `"true"`, stores fall back with a warning rather than failing boot.
- **Git**: one branch per fix; never push to a branch with an open PR; stacked PRs state their
  merge order; evals gate the merge, not the push.

## 8. Reviews that find real defects

A multi-lens independent review (correctness, privacy, state, readers, tests) with a sceptic
verifier per finding found 24 real defects the unit tests missed on one feature. Reviewers read;
they do not write. Put every known correction in a worker's brief up front; never message a
running worker with a correction (it spawns a duplicate racing the original).

## 9. Working with real backends

- Dev tokens expire; a passing READ is not proof a token is valid (writes 401 first).
- A whole-document PUT endpoint hangs on a partial body: GET → merge → PUT, always.
- A read-only census of what the backend actually stores settles design questions that
  documents cannot (what captions exist, whether an asset is copied by key or re-uploaded).
- Record every backend truth in the domain's contract doc and in the registry's probe findings.


---

<small>Source: <a href="https://github.com/marg-adk/marg/blob/main/docs/PLAYBOOK.md">docs/PLAYBOOK.md</a> — edit it there; the site mirrors the repository.</small>
