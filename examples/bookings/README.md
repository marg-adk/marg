# Example domain — table bookings

The second example, built by following [`skills/build-a-domain`](../../skills/build-a-domain/SKILL.md)
step by step, so it is also that skill's acceptance test. Its worksheet answers:

| Question | Answer |
|---|---|
| The job | Book a table at a venue: which venue, which day, for how many, which time, confirm, create |
| The entity and the write | `booking`; `create_booking` into `.data/bookings.json` (writes off in evals and CI) |
| The backend | a JSON file that validates nothing; venues from `fixtures/venues.json`; availability computed, so the no-availability path is deterministic |
| The slots | venue (asked, resolved by search); cuisine, area (from the record, shown); date, party size, occasion (the Details card); time (chips from availability); notes (optional) |
| Done | "Booking BKG-… confirmed — venue, day, time, party" |

| Part | File | What it shows beyond the first example |
|---|---|---|
| Manifest | `domain.json` | route hints that make the super agent choose between two domains |
| Tools | `mcp/server.ts` | `search_venues` (two look-alike names → the picker), `availability` (open slots, or the nearest alternatives), the triad |
| Steps | `steps/index.ts` | a `date` row in the Details card; a bespoke `StepDefinition` (the Time chips) fed by a tool, settling two slots when it moves the date |
| Mock | `mock/policy.ts` | registered under the domain's name, so two policies share one gateway |
| Evals | `evals/run-evals.ts` | nine scenarios: the happy path, the picker, no availability, a correction, words beside the card, the review, an injection probe, and routing to each domain |

Try it: `npm run gateway` (both examples are discovered), open http://localhost:8787, type
*"book a table at Harbour House for 4"*. The suite: `npm run gateway:evals & npm run evals:bookings`.
