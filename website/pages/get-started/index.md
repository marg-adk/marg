# Quickstart

Marg needs Node 22 or newer. Everything below runs on the scripted mock model, with no API key
and no network.

## Create a project

::: code-group

```bash [npm]
npx create-marg-app my-agent
cd my-agent
npm install
npm run gateway            # http://localhost:8787
```

```bash [the repository]
git clone https://github.com/marg-adk/marg.git && cd marg
npm install
cp .env.example .env       # LLM_CHAIN=mock
npm run gateway            # http://localhost:8787
```

:::

`create-marg-app` gives you the example domain (support ticket intake), the templates, the shared
skills, the scaffolder, and a `package.json` that depends on the published packages. The
repository gives you the same plus every check, the docs and the sources.

## Walk the journey

Open http://localhost:8787 and type **"ticket for Northwind: login fails on mobile"**.

1. **A customer picker.** Two look-alike customers match; the runtime draws a list, never prose.
2. **Category chips.** The model's question; the runtime's chips.
3. **The Details card.** A form the runtime draws, reads and validates in place. Type a question
   beside it and the model answers while the card is drawn again underneath.
4. **Priority chips**, then **the summary**: every value with its provenance (a record, a default,
   what you said), *Change something* to re-open one step, and the create.
5. **The create.** Refused with writes off, which is how the evals and CI run; with
   `AGENT_ALLOW_WRITES=true` it writes to the example's JSON backend.

The right-hand pane shows the draft filling itself as you answer.

## Switch the model

Edit one line in `.env`:

```bash
LLM_CHAIN=anthropic            # ANTHROPIC_API_KEY
LLM_CHAIN=openai,anthropic     # failover: LLM_OPENAI_API_KEY, then Anthropic
LLM_CHAIN=ollama               # a local model, no key
```

Nothing else changes. [Environment](/run/environment) lists every variable with its default.

## Run the gate

```bash
npm run gateway:evals &        # a second gateway on :8788 with writes OFF
npm run evals                  # the example's scenarios; the exit code is the gate
npm test                       # unit tests, including the widget under a fake DOM
```

In the repository, `npm run check:otel`, `check:scaffold`, `check:e2e`, `check:pack` and
`check:create` complete the gate CI runs on every pull request. [Evals](/build/evals) explains
the report and how to classify a red.

## Your own domain

```bash
npm run new-domain -- bookings --entity booking
```

Then follow the build order: tools, probe, schema, skill, steps, evals.
[A new domain](/build/new-domain) walks through it; [the example](/build/example) is the
reference for every part.
