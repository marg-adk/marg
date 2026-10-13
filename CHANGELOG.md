# Changelog

## Unreleased

- **deploy**: the image ships `tsconfig.base.json` (without it tsx lost the path mappings and
  the gateway crashed at boot — the first Render deploy failed on this); CI now builds the image
  and probes its health, playground and widget (`image` job, required).
- **docs**: the launch post, `docs/posts/the-model-must-never-read-yes.md` (the long form, the
  Show HN comment, the r/LLMDevs post, the thread), linked from the README.
- **docs**: the README opens with `docs/images/playground.gif`, the six-turn journey recorded from
  the playground on the mock model (0.14 MB).
- **playground**: `render.yaml`, a Render Blueprint for the hosted playground (mock model,
  writes off, no login, rate limits on), deployed at https://marg-playground.onrender.com and
  linked from the README.
- **core**: the form-reply pair parser scans instead of matching a regex that backtracked
  polynomially on long runs of spaces in user text (CodeQL, high). The Docker healthcheck and
  the CI gate poll `/api/health`, the path the gateway serves.
- **repository**: the gate runs on Node 22 and 24 with `npm run lint` (ESLint, correctness
  rules only) first; CodeQL, a security workflow (dependency review, `npm audit`; GitHub secret
  scanning with push protection on the repository) and the OpenSSF Scorecard run on every PR or weekly; Dependabot keeps npm and
  Actions current in grouped weekly PRs; CODEOWNERS, issue templates (bug, feature, domain
  request), a pull-request template that asks for the gate output and a classification of every
  red, `RELEASING.md`, `.nvmrc`, `.editorconfig`, and badges in the README.
- **packages**: every package is publishable — a build per package (`tsc -p tsconfig.build.json`
  to `dist/`, ESM + `.d.ts`), `exports`, `types`, `files`, `publishConfig.access: public`;
  `@marg/widget` is now a package (the file plus a manifest); `@marg/gateway` ships a
  `marg-gateway` command that registers the tsx loader and runs the compiled server. The tsx
  development path through `tsconfig.json` paths is unchanged.
- **create-marg-app**: `npx create-marg-app my-agent` copies the templates, the example domain,
  the shared skills and the scaffolder into a fresh project depending on the published packages.
- **core**: when installed from npm the project root is the working directory (walking up to the
  nearest `package.json` or `.git`), so `.env`, `domains/`, `examples/` and `shared-skills/` are
  found in the user's project; `AGENT_REPO_ROOT` still overrides.
- **gateway**: the playground page and the widget are located relative to their packages, not
  the repository; `/api/skills` honours `AGENT_SHARED_SKILLS_DIR`.
- **checks**: `check:pack` (every package packs clean) and `check:create` (a project from local
  tarballs installs, boots and passes the example suite); a `packages` CI job runs both.
- **release**: a tag `v*` runs the gate and publishes every package with provenance
  (`NPM_TOKEN`).

## 0.1.0 — 2026-10-13

First open-source release, extracted and generalised from a production agent.

- **core**: the domain-agnostic runtime — prompt assembly from markdown skills (typed
  variants, capabilities, security preamble), the model chain (Anthropic, any OpenAI-compatible
  endpoint, a scripted mock) with failover, breaker, retries and per-endpoint configuration,
  MCP tools with reconnect and hidden `internal_*` tools, sessions with bounded memory and
  healed history windows, durable stores with fallback, two-stage tool-output trimming,
  **runtime-owned steps** (draw / read / settle / chain / late draw / redraw / review / carry /
  dependencies / reload redraw), whole-content readers, the create gate and attested-list guard,
  tolerant ui-block parsing and sanitising, OpenTelemetry seam, structured logs off the main thread.
- **verdict**: typed decisions (`choice` / `noul` / `score`) with rules, System One (Laya / any
  compatible server), LLM logprobs and mock backends; a cascade; calibration maths; a CLI, an
  MCP server and a System One-compatible HTTP server.
- **gateway**: HTTP + SSE; sessions with verified identity and owner checks; the agent-token
  exchange; rate limits with runtime-turn refunds; usage caps in plan tokens shown as
  percentages; media (upload ≠ attach); voice (Deepgram or any Whisper-compatible endpoint);
  nudges; health, metrics, HTTP tracing; a metering sink; graceful shutdown.
- **evals**: the scenario runner with sharding, reruns, flake classification and a gate report.
- **widget**: streaming, chips, multichips, lists, cards with sections, toggles, forms with
  echoes, tables, progress, media, bars; resume, nudges, voice, uploads; link scheme allowlist.
- **example**: support ticket intake, end to end offline with a scripted mock model; 7 scenarios.
- **checks**: `check:otel` (the telemetry seam against in-memory exporters and a stub log sink),
  `check:scaffold` (the templates produce a domain that compiles and passes its own suite),
  `check:e2e` (the real write path with writes on); the widget driven under a fake DOM in tests.
- **observability**: Docker Compose for OpenObserve (+ optional collector), generated dashboards
  and alerts (`o2:dashboards`), an idempotent `o2:bootstrap`.
- **deploy**: a non-root Dockerfile with a health check, Compose profiles (stores, observability,
  decisions with Ollama + laya, edge with Caddy), a production env example, DEPLOY.md; a CI workflow.
- **docs**: the pattern, the lessons, the playbook, the production checklist, the client
  protocol, decisions, observability, metering, security, the auth design, six ADRs, guides, templates.
