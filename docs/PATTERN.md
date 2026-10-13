# The Marg pattern

This is the design pattern for a conversational agent that completes a job. It was extracted
from a production agent that creates records from a chat (a property listing, across five
property types, in a market where users write in two languages on a phone), then generalised
until nothing in it names that product. Each element below is a mechanism, not advice; the
runtime implements all of them.

## 1. The shape: domains, skills, tools, steps

A **domain** is one coherent job with its own tool surface, its own guardrails and its own eval
suite. It is a drop-in folder:

```
domains/<name>/
  domain.json        the manifest — the ONLY registration mechanism
  skills/            markdown prompts: one orchestrator + delta skills per variant
  mcp/server.ts      the tools, over MCP (stdio child process)
  schema/*.json      declarative slots, ask sets, mandatory sets, probe findings
  steps/index.ts     the runtime-owned moments (forms, chips, pickers)
  mock/policy.ts     a scripted model for the offline journey (optional)
  probe/             the empirical API-truth finder (dev-only, self-cleaning)
  evals/             the scenario suite — the regression gate
```

**Within a domain, compose skills; across domains, delegate through the super agent** (ADR-0001).
The super agent is a router, not a doer: it picks ONE domain per turn and delegates to that
domain's agent, which runs in its own context (its skills + its tools only). Sticky: it stays in
the current domain until intent clearly shifts; a mid-journey or finished chat never re-routes.
With a single domain the router costs nothing. A misroute degrades to a clarifying question,
never a wrong write.

**Skills are markdown, layered, delta-structured.** One orchestrator holds the whole workflow
(entry, cascade, ask sets, what the runtime owns). Sibling skills for variants are deltas: "all
orchestrator rules apply; this file defines only what is DIFFERENT for X". With entity types,
only the in-play type's skill and tools are sent (prompt halves, time-to-first-token with it).

**Tools follow a triad per entity:** `validate_*` (write-free; called after every slot-changing
turn — it powers the live draft pane, fills what a record knows, applies declared defaults,
lists what is missing) → `preview_*` (compose the full payload, still no write) → `create_*` /
`submit_*` (the real write). Read tools are unprefixed. **`internal_*` tools are gateway-only and
hidden from the model** — enforced by a filter, not by convention.

**The user's token rides MCP `_meta`**, never model-visible arguments, bound per call with
AsyncLocalStorage in the tool server; never persisted. The trace context rides the same `_meta`,
so the tool server's spans land in the gateway's trace.

## 2. The runtime owns the moments that must be right (ADR-0004)

A prompt rule lowers how often a model slips; it never reaches zero. On a real journey,
model-led asks were skipped a quarter to half of the time, a model attested `confirmed:true` on
its own, invented list items 1 in 64 chats even with a note covering that exact case, and copied
a correction without acknowledging it. Different models slip in different places. So the
moments that cost when wrong are the runtime's:

- **A step** draws its ask (a form card, chips, a picker), reads the reply **in code by its
  whole content**, writes the result to the draft, **carries** it into every later tool call
  (the model's own value for that key never stands), and tells the model one fact. The model
  never asks the question, never draws the block, never reads the answer.
- **The chain.** A settle flows straight into the next owed step in the SAME reply — no model
  call — and, when every step has ended and the draft is valid, into the confirmation summary.
- **The late draw.** A step owed on a model turn is drawn under the model's reply, with the
  model's own version of the question cut (one question per turn).
- **Words beside an open ask** go to the model with a runtime fact; the ask is drawn again under
  its answer. A typed "yes" while a step is open is not an answer to it.
- **Anything fetched from a record is SHOWN and CONFIRMED**, never asked. Any choice from
  reference data with two or more options is chips or a list, never prose.
- **The review.** "Change something" is a runtime section picker over the steps that settled;
  the picked step's own card re-opens pre-filled; dependencies re-ask what the change invalidates;
  the summary returns in code. Edits after the create write through (GET → merge → PUT on a
  whole-document backend) behind their own confirm gate.
- **Reload redraws the open ask.** The transcript endpoint draws the open step's block again on
  the last assistant entry, so a refreshed page shows what the user must answer.

## 3. Reading a reply by its whole content

A typed reply is a plain yes or no only when EVERY word in it is a confirm word, politeness, a
filler or the nouns of the question. "Keep this private please" starts with "keep" and is about
something else; "No, create it later" starts with "no" and is a refusal. Anything else is
CONTENT, left to the model. On a blind corpus of 521 realistic replies a leading-word reader
mis-took 235; the whole-content reader took 0.

The cost is asymmetric: a false "words" makes the user repeat a yes; a false yes settles a value
or performs a real write. Widening the yes-vocabulary to fix false refusals is what opens the
next hole: add only words that cannot carry content, rewrite look-alike phrases ("let me
confirm", "correct it") into non-yes tokens, and keep the create gate stricter than any other reader.

## 4. Typed decisions (ADR-0005)

An agent makes thousands of small judgements that are not prose: which domain, is this a yes,
which option, is this safe to write. The runtime asks these as typed questions — `choice`,
`noul` (yes/no → P(true)), `score` — and a cascade answers them: deterministic rules first
(free, certain), a decision model second (Laya, open-weight, ~30 ms, over the System One
protocol), a generative model with logprobs last. Confidence is a property of the distribution;
calibrate it on your own labelled data before a threshold means anything (`@marg-adk/verdict`
ships the maths and a report).

## 5. The write gate, three times

1. The skill rule: never call create without the user confirming the summary.
2. The tool schema: `create_*` refuses without `confirmed:true` and without the env write flag
   being the literal string `"true"`.
3. The runtime guard: the summary must have been shown for THIS draft (fingerprinted) and the
   user's last message must be a plain go-ahead by its whole content.

Never weaken any layer. Agent-side validation may be the ONLY validation: the first backend we
probed accepted a create with every field stripped. Links are tool-composed or templated, never
model-invented, and every link a client opens passes a scheme allowlist.

## 6. The ops spine (ADR-0002, ADR-0003)

- **Stores with fallback.** Redis for atomic fixed-window counters (rate limits, caps), Mongo
  for sessions and ledgers; unset or unreachable ⇒ memory/files, so a laptop and CI need no
  services. Multi-node without Redis = limits silently multiply by node count.
- **Sessions:** bounded working set with lazy hydration; history windowed on turn boundaries
  and healed so a tool call is never orphaned from its result (that wedges a session with 400s).
- **The model chain:** ordered endpoints, failover on any error before the first streamed
  delta, a circuit breaker per endpoint, same-endpoint retries that honour Retry-After, and
  configuration PER ENDPOINT (temperature, reasoning effort, token-cap field, price, notes).
- **Cost:** plan tokens (a cost-weighted count) are what caps and users see — as a percentage,
  never tokens; two-stage tool-output trimming; the typed prompt; a cheap decision instead of a
  model call wherever a decision will do.
- **Metering is pass-through:** bill what vendors bill you; your own cache hit costs nothing;
  deterministic event ids; no content in events.
- **Observability:** one `invoke_agent` span per turn, `chat` per model call, `execute_tool` per
  tool, the runtime's step spans, `behaviour.*` events wherever the runtime corrected the model;
  every log line carries the trace id; a feature is not done until it is on a panel.
- **Security by default:** login required, identity verified against your auth service and
  failing closed, a session id is an id not a credential (owner checks answer 404), admin
  routes fail closed, generic error bodies with an id, an injection preamble in every prompt,
  PII scrubbed from read tools, SIGTERM drains turns.

## 7. The process is part of the pattern

Build order **tools → probe → schema → skill → steps → evals**. Evals before and after every
change; every red classified (check brittleness / model flake / real regression / pre-existing);
shard the suite for speed; a mutation pass to prove the checks bite. Issue tags thread roadmap,
commits, code comments and scenario ids. Every source file opens with what it is, what comes in
and out, who talks to it; guard code cites the incident that caused it. Standing context lives
in a short file every session reads first. External asks are numbered with owners; anything
built on an unconfirmed contract is marked provisional in code. See docs/PLAYBOOK.md.
