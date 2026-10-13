# Field notes — what we learned building a production agent

Every line below cost something to learn. They are grouped by the part of the system they
shaped; the code cites them where it applies.

## Models

- **A model cannot be told to be reliable.** Instructions lower a slip rate; they never zero it.
  A model that filled a list "for the user" did so in 8 of 40 chats; the better model in 1 of
  64 even with a note covering that case. The guard made it 0 for every model.
- **Models differ in where they slip.** One rejects a fixed temperature, one needs a thought
  signature echoed back, one sends buttons with no prose on skills tuned for another. Configure
  each endpoint separately; never run a lowest-common-denominator setting.
- **Per-model notes belong to the endpoint**, appended only when that model serves the call.
  One model's corrective notes are noise to another.
- **Prompt text is not free.** Three review paragraphs raised one scenario's flake rate from 0
  in 16 to 4 in 8. Measure a prompt change over several runs and compare failing sets.
- **Compare models on blended cost under YOUR prefix**, not list price. With a ~40k-token
  cached prefix per call, the cache-read price and the cache-write surcharge decide the bill.
- **A model run-to-run varies a lot** (32–45 of 45 on identical code in one day). Never judge a
  change on one run; compare the sets of failing scenarios over three.
- **Failover must happen before the first streamed token**; afterwards a second endpoint would
  duplicate text. Keep the user's draft persisted so "try again" loses nothing.
- **Reasoning-model knobs change what tools are allowed.** Some endpoints accept function
  tools only with reasoning effort "none" on chat completions. Put the knob on the endpoint.

## Prompts and skills

- **One question per turn.** Several questions in one message make the next reply
  unattributable; a bare value while several slots are open must be attributed explicitly.
- **Never combine an options question with free-text asks** in the same turn.
- **Anything a record knows is shown and confirmed, never asked.** The product moment is "we
  already know your unit"; letting it slide silently into the summary wastes it.
- **Any choice from reference data with ≥2 options is chips or a list, never prose.** An
  irrelevant chip is the real bug, not a lone chip.
- **Say "never announce the step after it"; do not enumerate steps or give example phrases.**
  Telling the model what the runtime does made it narrate "photos, video and visibility".
- **Describe the runtime's lines, never quote them.** A model imitates lines it has seen in
  the history ("Taking this as Sale. Right?") and re-asks them.
- **Off-scope asks get "that's outside what I can do here", never "let's finish this first"**
  — the latter implies it could be done later. Declare capabilities from the installed domains.
- **A tool parameter named like a UI heading invites a UI heading.** `header` became
  "Choose at least 5 key features" and the reference lookup returned nothing.
- **Load only the in-play variant's skill and tools.** 103k → 44k characters per call, the
  suite 30% faster, rate-limit waits gone. Once the type is set, remove it from the tool's enum
  or the model re-sets it "to be safe" (27 of 37 calls).

## Reading what the user said

- **Read a reply by its WHOLE content, never its first word.** 235 of 521 realistic messages
  were mis-read by a leading-word reader; 0 by the whole-content reader.
- **Widening the yes-vocabulary opens the next hole.** Add only words that cannot carry
  content; rewrite look-alike hand-offs into non-yes tokens; keep the create gate strictest.
- **A lone number must be the whole message** before it is a value ("make it 3 bathrooms" is
  not a price).
- **Explicit words win over inference** (a stated purpose beats a figure's size); questions are
  not statements; a message cut off after a connector is never a bare yes.
- **A figure said with a money unit is not an id** ("40 L a month" is not unit 40).
- **A confirm of the shown value plus a plain remark settles;** a question, a "but", a second
  figure or a refusal does not.

## Runtime-owned steps

- **Validate tools are stateless:** the runtime's settle call must send the whole typed draft
  or the problems list lies.
- **A failed validate (an MCP error) must never read as a successful validate.**
- **Carry settled values into every validate/preview/create call**; a different value stands
  only when the user said it in words since.
- **The draft the pane shows is built from the arguments the MODEL passed**, so guards run on
  those arguments in place, not on a copy.
- **Reset dependents on a change**: price → the analytics verdict, furnishing → fixtures, type
  → specification, fewer photos → the video choice, project → everything below it.
- **A runtime-answered turn is stored with its blocks**, so a reload draws it again; the
  transcript endpoint draws the open ask on the last entry.
- **A step waits for a complete draft**; it never asks over an incomplete record.
- **Every runtime moment emits a behaviour event with counts and enums only, never text.**
- **Runtime-answered turns must not count against the per-session rate limit**: a user
  tapping through five cards in a minute is the product working (a prod chat hit the limit on
  its 11th tap).

## The write path

- **Probe first.** The first backend accepted a create with EVERY field stripped (0 rejections
  in ~90 cases); misspelled duplicate keys were the real schema; a "prod" base URL shared the
  dev database; a `GET …/status/update/{id}` wrote; a POST to an unknown admin route created a
  record. Never probe unknown routes with POST; treat any 200 with an id as a write.
- **The confirm gate ×3.** The model attested `confirmed:true` after the user sent a change.
- **Timeout + idempotency on the write**, keyed by session + draft fingerprint; reconcile an
  ambiguous failure before creating again.
- **No silent fuzzy fallback on the write path.** Fuzzy matching is for suggestions; the write
  uses only ids the user confirmed.
- **An environment write guard must not be a substring test** ("development" in the host name).
  Use an explicit flag that must equal the literal "true".
- **Whole-document PUT:** read, change only allow-listed paths, re-read right before the write,
  write, read back, say one line. Compare references by id (a GET may populate them).
- **Create seeds its own status event** when the server injects nothing — a record with an
  empty status history was invisible in every tab.

## Clients

- **Upload ≠ attach.** Files upload at once, keys wait on the session, attach the instant the
  write returns an id; the create payload ships an empty media block so a media hiccup never
  blocks the main write. Attach is idempotent. Bytes cross the MCP boundary as a temp file,
  never base64 over stdio.
- **A model-emitted link block is XSS in every host page** without a scheme allowlist.
- **Fence junk is real:** one block in forty came with junk glued to the closing fence, a
  two-backtick close, or no fence at all; the stream must hold back fence fragments.
- **A model re-emits its pre-tool text after the tool answers** — dedupe sentences and blocks.
- **The user's bubble shows a readable echo of a form submit**, not the wire text.
- **Pin the widget's script URL to its version**; a proxy's cache can hide a shipped fix for hours.
- **"List another" = a new session**; one chat = one job.
- **A completed chat's replay must not resurrect link pills** the live turn filtered out.
- **Completion links are composed from today's templates**, not the ones stored at create time.

## Sessions and stores

- **A session id must not be a bearer credential**; with an open listing endpoint it was a full
  hijack chain. Owner checks answer 404.
- **Any bearer string read any chat** until identity was verified against the auth service.
  Verify, cache 60 s, fail closed.
- **Never load every persisted session into RAM at startup**; hydrate on miss, evict idle.
- **A windowed history must never orphan a tool call from its result**; both providers answer
  400 forever.
- **node-redis reconnects forever**: bound the first connect or startup hangs on a down Redis.
- **Any session-taking route that calls a tool must attach the request's bearer first**;
  tokens are never persisted with sessions.
- **A process whose stdout is a protocol channel must log to stderr** (the MCP child's info
  lines were silently parsed as JSON-RPC noise).
- **stdout is synchronous under Docker**: log off the main thread.

## Observability and cost

- **A feature is done when it is visible on a panel**: a span, a counter or behaviour event, a
  log line with the trace id, a panel when someone will look.
- **OTLP/JSON failed on non-zero doubles with our backend; protobuf did not.** Custom span
  attributes arrive as strings — cast in panel SQL. A field exists only after a span carried it,
  so always emit the attributes panels filter on, and prime counters at startup.
- **Search the telemetry for a private string after building a private path**; a note typed
  by the user turned up in a span input and a trace line until redaction covered every carrier.
- **Users see a percentage of their cap, never tokens.** Plan tokens (cost-weighted) track the
  bill with r = 1.00; raw totals varied 2.4×, billable-only 8.9×.
- **Bill what vendors bill you**; a cache hit on your own infrastructure costs nothing.

## Process

- **Evals before and after every change.** When a check fails, decide out loud: check
  brittleness (fix the check) or a real regression (fix the agent) — and record which.
- **Classify every red**: green on a serial rerun = model flake (ledger it); red on a clean
  baseline worktree too = pre-existing; else a regression. A credit outage mid-run is a
  transport error, not a result.
- **Shard the suite**; 12 shards against a mock finish in minutes; 3 shards is the ceiling
  against a real provider's rate limit; 6 hit it.
- **Run the full gate, not a targeted subset**: it caught two regressions the unit tests missed.
- **Mutation checks prove the checks bite**: text mutants in scratch copies of the repo.
- **The eval runner's own copy of the rules goes stale**: share the reader with the runtime.
- **Do not run the gateway while editing readers**; it loads code at start.
- **One branch per fix; never push to a branch with an open PR.** Three races with merges.
- **Never give hour-scale estimates unprompted**; give the parallel number and what is cut.
- **Fix the class in code, not the instance**; add an every-scenario check for it.
- **Don't ask for confirmation on small, obvious things** inside the branch; ask for real
  decisions, pushes, flags that change what ships.
- **Unattended device work touches nothing private**; credentials stay the owner's to type.
