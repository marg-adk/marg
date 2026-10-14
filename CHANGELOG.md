# Changelog

## Unreleased

- **cli**: the package is `@marg-adk/cli` (npm refuses the bare name `marg` as too similar to
  existing packages); the command is still `marg`. `bin` paths no longer start with `./`, which
  npm 11 rewrote on publish.
- **release**: npm publishing by trusted publishing (OIDC, no token, provenance automatic);
  `scripts/publish-first.sh` for a package's first version by hand; RELEASING.md describes the
  one-time setup per package.

## 0.2.0 — 2026-10-14

The adoption release: installable from npm, a site, a playground that is also the dev UI, one
command, a method for coding agents, a second example, every model provider, and the pipelines
of a public repository.

- **models**: presets for every provider a developer is likely to meet — Vertex AI, Azure OpenAI
  (the `api-key` header), Bedrock, LiteLLM, xAI, Cohere, Hugging Face, Cerebras, Perplexity,
  NVIDIA — beside the existing OpenAI, Gemini, Ollama, vLLM, Groq, Mistral, DeepSeek, Fireworks,
  Together, OpenRouter and the native Anthropic adapter; `gen_ai.provider.name` follows the
  semantic conventions for the new ones; a unit test resolves every preset from the environment.
- **docs**: `docs/providers/` (one page per model provider, with the env lines; Gemma, gateways
  such as Apigee, on-device runtimes explained) and `docs/integrations/` (observability backends
  over OTLP — Langfuse, Datadog, Grafana Cloud, Honeycomb, Phoenix, SigNoz, New Relic, Jaeger —
  stores, speech, decisions, MCP tools, other frameworks, hosting, coding agents); both are
  sections on the site.
- **skill**: `skills/build-a-domain/SKILL.md`, the method for building a domain as a skill a coding
  agent follows (the worksheet, the build order, the gate, the classification rule, the never-rules);
  Claude Code loads it from `.claude/skills`, `AGENTS.md` points other agents at it, `create-marg-app`
  installs it in new projects, and the site shows it under Build.
- **example**: `examples/bookings`, the second domain, built by following the build-a-domain
  skill: a venue picker, a Details card with a `date` row, a bespoke Time step fed by an
  availability tool (the no-availability path offers the nearest days and moves the date), its
  own mock policy and nine scenarios including routing to each domain (`npm run evals:bookings`,
  in CI).
- **core**: a `date` form row kind (an ISO day; the widget draws a date input; `isIsoDay`); the
  mock model registry is per domain (`registerMockModel(fn, domain)`), and the agent names its
  domain on every model call, so two example domains share one gateway; a utility hop with no
  domain gets an empty mock answer. **evals**: `TurnResult.domain` and the `inDomain(name)` check.
- **repository**: CI fails when a generated path (the site's mirrored docs or build, a package's
  `dist/` or payload) is tracked; Dependabot ignores major bumps of `@types/node` (the engine is
  Node 22).
- **site**: https://marg-adk.github.io/marg — VitePress on GitHub Pages, built from the
  repository's docs on every merge (`website/`, `npm run site:build`): a landing page, Get
  started · Build · Components · Run · Reference · Community, search, a comparison page, an FAQ.
  Pull requests build it, so a dead link fails the PR.
- **marg**: the `marg` command on npm — `web` (the gateway and the playground), `new` (a domain
  from the templates), `evals` (every suite against a writes-off gateway), `verdict` (a typed
  decision from the shell), `check` (the project's gate: typecheck, then every suite with writes
  off on its own gateway). `create-marg-app` wires it into a new project's scripts; `check:create`
  runs `marg check` in the created project.
- **docs**: a review of adk.dev and what Marg takes from it (`docs/reviews/`), and ROADMAP
  "0.3 — the surface": the site, the playground as the dev UI, a `marg` CLI, a skill for coding
  agents, provider pages, user simulation.
- **playground**: redesigned as the dev UI — a plain top bar with the model and writes status,
  one centred conversation, the live draft and a new **trace** pane (per turn: runtime or model,
  every tool call with its time, usage, the create) as side panels that collapse, past chats in a
  drawer, the domains' example openers on the empty state, usable on a phone. The README GIF is
  re-recorded on it.
- **widget**: `header: false` for host pages with their own chrome; `onTurn(turn)` hands the host
  every completed turn's facts (domain, kind, tool trace, usage, completion); bubbles hug their
  text. `/api/health` lists each domain's example openers.
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
  `@marg-adk/widget` is now a package (the file plus a manifest); `@marg-adk/gateway` ships a
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
  (with a token at the time; trusted publishing since — see Unreleased).

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
