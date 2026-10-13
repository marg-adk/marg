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
- Publish `@marg/types`, `@marg/core`, `@marg/verdict`, `@marg/evals`, `@marg/metering`,
  `@marg/gateway` (with a `marg-gateway` bin) and `@marg/widget` (the file plus a manifest).
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

## Later

- A calibration workbench for Verdict: label, fit, plot reliability, choose the abstention threshold.
- Alternative clients: a React component and a terminal client speaking the client protocol.
- Mobile notes: the widget in a WebView with the agent-token exchange, measured on a low-end device.

Proposals are welcome as issues; decisions that change the pattern go through an ADR
(`docs/adr/TEMPLATE.md`).
