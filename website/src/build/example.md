# Example domain — support ticket intake

The smallest honest domain: everything a real one has, nothing invented.

| Part | File | What it shows |
|---|---|---|
| Manifest | `domain.json` | the router card, steps order, slot labels, the entity name, the mock policy |
| Tools | `mcp/server.ts` | reads (`search_customers`, `reference_data`), the triad (`validate_ticket_slots` fills from the record and applies defaults, `preview_ticket`, `create_ticket` with the write gate), `internal_*` media tools, the `reg()` wrapper (auth + trace context from `_meta`) |
| Skill | `skills/support-intake/SKILL.md` | entry, the customer cascade (picker on ≥2 matches), the category ask, what the runtime owns |
| Schema | `schema/ticket-schema.json` | slots with sources, mandatory sets, ask sets, runtime steps, probe findings |
| Steps | `steps/index.ts` | a form step (Details) and a chips step (Priority) from `stepHelpers` |
| Mock | `mock/policy.ts` | the model's part of the journey as a state machine — the offline path |
| Evals | `evals/run-evals.ts` | seven scenarios: happy path, confirm gate, words beside a form, partial form, the review, injection, summary defaults |
| Fixtures | `fixtures/customers.json` | reference data with two look-alike names (the picker) |

Try it: `npm run gateway`, open http://localhost:8787, type
*"ticket for Northwind: login fails on mobile"*. Data lands in `examples/support-intake/.data/`
(tickets.json, uploads) when writes are on.

Copy it: `npm run new-domain -- <name>` scaffolds from `templates/`, or copy this folder into
`domains/<name>` and replace the backend behind the tools.


---

<small>Source: <a href="https://github.com/marg-adk/marg/blob/main/examples/support-intake/README.md">examples/support-intake/README.md</a> — edit it there; the site mirrors the repository.</small>
