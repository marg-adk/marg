# Guide: a new domain

```bash
npm run new-domain -- bookings            # scaffolds domains/bookings from templates/
```

Then, in the build order (docs/PLAYBOOK.md):

1. **Tools** — `domains/bookings/mcp/server.ts`. Implement reads (`search_*`, `get_*`,
   `reference_data`) and the triad: `validate_booking_slots` (write-free; returns `problems`,
   `from_record`, `defaults`), `preview_booking`, `create_booking` (refuses without
   `confirmed:true` and `AGENT_ALLOW_WRITES === "true"`; returns `{created:true, entity_id,
   label?, entity_url?}`). Keep `internal_*` for gateway-only work (uploads, attach). Wrap every
   handler with the `reg()` pattern from the example (auth context + trace context from `_meta`).
2. **Probe** — `domains/bookings/probe/probe.ts` against the dev backend with `--yes`: one
   known-good create, then one field stripped at a time; tag, clean up, report. Fold the
   findings into the registry.
3. **Schema registry** — `schema/booking-schema.json`: slots with sources, mandatory sets, ask
   sets, probe findings. Keep the validate tool reading it.
4. **Skill** — `skills/bookings/SKILL.md`: routing, entry, the cascade, ask sets (one question
   per turn), validation after every change, what the runtime owns, never-rules. Deltas for
   variants ("all orchestrator rules apply; only X differs").
5. **Steps** — `steps/index.ts` from `stepHelpers` (docs/guides/new-step.md); list their order
   in `domain.json` (`step_order`, or per type under `types.<t>.steps`).
6. **Manifest** — `domain.json`: name, title, description (the router card), route hints,
   mcp, skills, shared skills, steps, slot labels, hidden slots, attested lists, entity names.
7. **Mock policy** (optional but recommended) — `mock/policy.ts` with `registerMockModel`: the
   model's part of the journey as a state machine, so CI runs the whole domain with no key.
8. **Evals** — `evals/run-evals.ts` from the template; the coverage checklist in the playbook.

Run `npm run gateway` (the domain is discovered at boot), walk the journey in the playground,
then `npm run gateway:evals & npm run evals`.

## With entity types
Declare `types` in the manifest (title, skill, tools, keywords, steps, flags) plus
`core_skills` for the orchestrator and `type_tool` if you rename `set_type`. Only the in-play
type's skill and tools reach the model.

## Media
Implement `internal_upload_media`, `internal_attach_media`, `internal_detach_media`
(optionally `internal_arrange_media`) and set `AGENT_MEDIA_DOMAIN`; the gateway does the rest.


---

<small>Source: <a href="https://github.com/marg-adk/marg/blob/main/docs/guides/new-domain.md">docs/guides/new-domain.md</a> — edit it there; the site mirrors the repository.</small>
