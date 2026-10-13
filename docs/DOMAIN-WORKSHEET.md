# Domain worksheet — answer these before writing code

It front-loads the questions that cost the most when discovered late. Keep the filled copy in
the domain folder.

## 1. Who is the user, and what is the money path?
| Question | Your answer |
|---|---|
| Who talks to the agent? (expertise, device, patience, language register) | |
| The ONE flow that must work end to end first | |
| The irreversible write (the tool, the backend call) | |
| What confirms it (the summary → the explicit yes → `confirmed:true`) | |
| What "done" looks like in the UI (end-state card, deep link, next action) | |

The irreversible write defines everything downstream: the confirm gate, the write guards,
the probe, the suite's most important scenarios.

## 2. Domain decomposition
A domain = one coherent job with its own tool surface, guardrails and eval suite. If two
capabilities would share >70% of their tools, they are one domain (compose skills inside it);
if their guardrails differ ("never submit without confirmation" vs "summarise freely"), they
are separate domains (delegate). Ship exactly one domain first.

| Domain | Job (one line) | Tool surface | Irreversible writes? | Ship order |
|---|---|---|---|---|
| | | | | 1 |

## 3. The upstream API reality (do this BEFORE designing slots)
- Real endpoints, auth scheme, environments. Which base URLs share a database?
- Does the server validate anything? (Write the field-stripping probe early.)
- Schema warts to preserve (misspelled duplicate keys that are the real fields).
- Reference data (customers, catalogues, locations) and how it is searched; cache label → id.
- The auth contract for acting AS the user. Never let a server-side token substitute in production.
- Whole-document update semantics? Does any GET write?

## 4. Slots and the conversation
- Entity types / variants × purposes → the schema registry: slots, sources (`ask`,
  `derive_<record>`, `default`, `computed`, `runtime_step:<key>`), mandatory sets, ask sets.
- The cascade: which slots derive from a record pick vs must be asked.
- Which moments are the runtime's (forms, pickers, confirmations) and which the model's.
- Merge vs replace semantics for corrections (validate merges, preview/create replace).
- The users' register, vocabulary and magnitude conventions → the conversation-behaviour skill.

## 5. Trust and safety surface
- What can a prompt-injected turn do at worst? (A wrong write? Reading another user's data? A link?)
- What data is sensitive (contact details, identifiers, notes)? Where is it scrubbed or masked?
- Flows the agent must refuse (advice it is not licensed to give).

## 6. Evals and probes
- Every flow above → a scenario first. The suite is the regression gate.
- The probe: `--yes`, tagged records, self-cleaning, a report folded into the registry.
- A flake ledger from day one.

## 7. Channels
- [ ] Web widget   - [ ] Live draft pane   - [ ] Voice notes   - [ ] Media upload (upload ≠ attach)
- [ ] Resume / nudges / completion   - [ ] Mobile web-view host (docs/SDK-AUTH.md)
