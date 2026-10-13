# Roadmap

## 0.1 — here

The runtime, Verdict, the gateway, the widget, the eval runner, the metering client, the
support-intake example, templates and a scaffolder, docs with six ADRs, deploy and observability
as code, and the gate: unit tests, the widget under a fake DOM, the OpenTelemetry check, the
scaffold check, the real-write e2e, the example suite. All of it runs offline with no key.

Known gaps: the OpenObserve bootstrap, dashboards and alerts are ported from a production setup
and not yet re-verified against a live instance from this repository; Laya ships with the
calibration maths and a CLI but no published calibration set; there is one example domain.

## 0.2 — the adoption push

0.1 is ready to be tried. 0.2 makes it ready to be adopted. The items are in order of leverage;
each has an acceptance test, and the gate (`CLAUDE.md`) runs before and after every one.

### 1. Installable: publish the packages, and `create-marg-app`

Why: every package is `private` with `main` on TypeScript source, so a developer must fork the
monorepo. Frameworks are adopted through npm.

- A build per package: `tsc -p tsconfig.build.json` to `dist/` (ESM + `.d.ts`), `exports`,
  `types`, `files`; drop `private`; `publishConfig.access: public`. The tsx dev path through
  `tsconfig.json` paths keeps working.
- Publish `@marg-adk/types`, `@marg-adk/core`, `@marg-adk/verdict`, `@marg-adk/evals`, `@marg-adk/metering`,
  `@marg-adk/gateway` (with a `marg-gateway` bin) and `@marg-adk/widget` (the file plus a manifest).
- `packages/create-marg-app`: `npx create-marg-app my-agent` copies `templates/` and the example
  into a fresh project whose `package.json` depends on the published versions, then prints the
  next steps.
- A release workflow: tag `v*` → CI → `npm publish --provenance` with an `NPM_TOKEN` secret.

Accept: `npm pack --dry-run` is clean for every package; in an empty folder
`npx create-marg-app demo && cd demo && npm install && npm run gateway` opens the playground;
`check:scaffold` and the example suite stay green.

### 2. Seen in thirty seconds: a GIF and a hosted playground

- Record the six-turn journey from the README (opener, customer pick, category, the Details
  card, priority, confirm) as `docs/images/playground.gif`, under 3 MB, placed directly under
  the README's one-liner.
- Host the gateway on a free tier (Fly, Render or Railway) with `LLM_CHAIN=mock`,
  `AGENT_ALLOW_WRITES=false`, `AGENT_REQUIRE_LOGIN=false` and the rate limits on; link it in the
  README and say that sessions may be lost on redeploy.

Accept: the README's first screen shows the agent drawing a form; the hosted link survives a
page reload.

### 3. The launch post

The hook: on a blind corpus of 521 typed replies, a leading-word reader mis-read 235 as a bare
yes or no; reading the whole message mis-read none. Working title: "The model must never read
yes". Content: the four field numbers from the README, the runtime-owned step pattern with a
twenty-line example, the write gate that exists three times, the offline gate that runs in CI
with no key. Link the readers guide and the example domain. Post on Show HN, r/LLMDevs and a
LinkedIn or X thread, the same day the packages land on npm.

Accept: the post is published and the README links it.

### 4. A second example: bookings

`examples/bookings`: a venue picker (a search tool that returns two or more matches), a `date`
row kind in the Details form (forms.ts and the widget), an availability tool that returns open
slots drawn as a runtime chips step, party size, the summary, the create. Its own mock policy
and at least seven scenarios: the happy path, the picker, the no-availability path, a
correction, words typed beside the card, the review, an injection probe. Runs in CI.

Accept: `npm run evals:bookings` is green, and a two-domain scenario shows the router choosing
between the two examples.

### 5. An English core, opt-in lexicons, and the install warning

- Move the Hindi and Hinglish words and the Hindi-specific rewrite rules out of
  `packages/core/src/reply-words.ts` into `packages/core/src/lexicons/hinglish.ts`, an
  extension of words plus rewrite regexes; `extendLexicon` accepts rewrite rules; opt in with
  `AGENT_LEXICONS=hinglish` or a call at boot. The example stays English.
- Tests: the English suite as is, plus a Hinglish test that loads the extension and keeps
  today's cases. Document that the blind-corpus numbers were measured with that register loaded.
- README quickstart: one line explaining the npm 11 install-script warning for esbuild and
  fsevents, and that approving them is optional.

Accept: no Devanagari or Hinglish tokens remain in `reply-words.ts`; all tests green;
`docs/guides/readers.md` updated.

### 6. A Python tool-server template

`templates/mcp-server.template.py` on the official `mcp` SDK (FastMCP over stdio) with the
same tools and contracts: the validate, preview and create triad, the bearer in
`_meta["agent/auth"]`, the trace context in `_meta`; `domain.json` with
`mcp: { command: "python", args: [...] }`; `npm run new-domain -- <name> --lang python`;
`docs/guides/python-tools.md`; a CI job on Python 3.11 that runs the scaffold check for the
Python variant.

Accept: the Python scaffold check is green in CI.

### 7. Maintaining it

Issue templates (bug, feature, domain request), a pull-request template that asks for the gate
output and a classification of every red, `RELEASING.md` (tag, changelog, publish),
Discussions on, a reply to every issue within a day, a release every two to three weeks, and
`good first issue` labels on the sub-tasks of items 4 to 6.

## 0.3 — the surface

0.2 makes Marg installable. 0.3 makes it findable and legible: the site, the dev UI, one command,
and a method a coding agent can follow. The reasoning is in
[docs/reviews/adk-dev-2026-10.md](/community/reviews/adk-dev-2026-10); the items are in order of
leverage, and the first ships before 0.2's items 4–6 because it multiplies everything after it.

### 1. The site

VitePress on GitHub Pages at `marg-adk.github.io/marg`: a landing page (one sentence, one button,
the GIF, the quickstart in tabs, four feature sections, the field numbers, an FAQ), the docs
reorganised into Get started · Build · Components · Run · Deploy · Reference · Community, search,
a "since" line per page, and a comparison page that states the wedge next to the number. Built
and deployed by CI on every merge to `main`.

Accept: the site is live, every page in `docs/` is reachable from the nav, search finds
"readYesNo", and the README's first links point at it.

### 2. The playground as the dev UI

One centred conversation; the draft and a new trace pane as side panels that collapse; suggested
openers on the empty state; a plain header; usable on a phone. The trace shows the route decision
and its confidence, each step's state, every tool call with arguments and result, the model's
turns and timings, from the gateway's per-turn data plus one endpoint where needed.

Accept: the six-turn journey in the GIF is re-recorded on the new UI; the trace pane shows the
create gate refusing a premature yes; `npm test` (the widget under the fake DOM) and the example
suite stay green.

### 3. The `marg` CLI

`marg web | new | evals | verdict | check` in one published package, wrapping the scripts;
`create-marg-app` wires it into a new project's scripts.

Accept: `npx marg web` in a created project opens the playground; `check:create` uses it.

### 4. A skill for coding agents

`skills/build-a-domain/SKILL.md`, installable into Claude Code and Codex: the worksheet, the
build order, the gate, the classification rule, with the example domain as the reference.

Accept: a coding agent given the skill and "a bookings domain" produces a domain that passes
`check:scaffold`'s shape and its own suite.

### 5. Provider and integration pages

A page per model provider with its env lines; a page per store, observability backend and voice
provider; "use Marg tools from another framework" and "a Marg domain behind an A2A card".

Accept: every env family in `docs/ENVIRONMENT.md` has a page that shows it working.

### 6. Evals: user simulation

A scripted or model-played user for scenarios that need free text beyond the mock policy, with
the same deterministic checks and the same classification.

Accept: one example scenario runs with a simulated user in CI on the mock model.

## Later

- A calibration workbench for Verdict: label, fit, plot reliability, choose the abstention threshold.
- Alternative clients: a React component and a terminal client speaking the client protocol.
- Mobile notes: the widget in a WebView with the agent-token exchange, measured on a low-end device.

Proposals are welcome as issues; decisions that change the pattern go through an ADR
(`docs/adr/TEMPLATE.md`).


---

<small>Source: <a href="https://github.com/marg-adk/marg/blob/main/ROADMAP.md">ROADMAP.md</a> — edit it there; the site mirrors the repository.</small>
