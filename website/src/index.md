---
layout: home
title: Marg — agents that finish the job
hero:
  name: Marg
  text: Agents that finish the job.
  tagline: The open-source Agent Development Kit for conversational agents that complete a transaction. The runtime owns the moments that must be right; the model owns the conversation. TypeScript, MCP, any model.
  actions:
    - theme: brand
      text: Get started
      link: /get-started/
    - theme: alt
      text: Try the playground
      link: https://marg-playground.onrender.com
    - theme: alt
      text: GitHub
      link: https://github.com/marg-adk/marg
features:
  - title: The runtime owns the moments that must be right
    details: Forms, pickers, option chips, the confirmation summary and the create gate are drawn and read by the runtime, in code, by the whole message. A model that skips a question, invents a value, or reads "yes but change the title" as a yes cannot do so here.
    link: /build/pattern
    linkText: The pattern
  - title: Typed decisions, not prose
    details: Which domain, is this a yes, which option, is it safe to write — asked as choice / noul / score questions and answered by rules first, a decision model second, an LLM with logprobs last, with calibrated confidence.
    link: /components/decisions
    linkText: Verdict
  - title: Evals as the ratchet, offline
    details: Scripted conversations against a writes-off gateway with deterministic checks, a mock model that plays the model's part, flake classification, a gate that runs in CI with no key and no network.
    link: /build/evals
    linkText: Evals
  - title: A production spine
    details: Identity that fails closed, owner checks, rate limits, usage caps, pass-through metering, OpenTelemetry in the GenAI conventions, dashboards and alerts as code, graceful deploys, a widget people use on a phone.
    link: /run/production-checklist
    linkText: Going to production
---

<div class="marg-gif"><img src="/images/playground.gif" alt="The playground: a ticket typed in one sentence, a customer picker, category chips, a details card the runtime draws and reads, priority chips, a summary with provenance, the create."></div>

## Two minutes to a running agent

::: code-group

```bash [npm]
npx create-marg-app my-agent && cd my-agent
npm install
npm run gateway        # http://localhost:8787 — the scripted mock model, no key
```

```bash [the repository]
git clone https://github.com/marg-adk/marg.git && cd marg
npm install && cp .env.example .env
npm run gateway        # http://localhost:8787
```

:::

Open the playground and type **"ticket for Northwind: login fails on mobile"**. A customer picker,
category chips, a details card the runtime draws and reads, priority chips, a summary with
*Change something*, the create. Switch to a real model by editing one line in `.env`
(`LLM_CHAIN=anthropic`, `LLM_CHAIN=openai,anthropic`, `LLM_CHAIN=ollama`); nothing else changes.

## Measured in the field

The numbers that justified the design, from the production agent Marg was extracted from.

<div class="marg-numbers">

| Observation | Result |
|---|---|
| Questions a model-led prompt skipped, despite the rule | 25 to 50 percent of turns |
| List items a model attested that the user never said | 1 chat in 64 |
| Typed replies a leading-word reader mis-read as a bare yes or no, blind corpus of 521 | 235 |
| The same corpus, read by the whole content | 0 |
| `ui` blocks malformed around the fence in production traffic | about 1 in 40, all parsed |

</div>

[The model must never read "yes"](/community/posts/the-model-must-never-read-yes) tells the story behind the third and fourth rows.

## Is Marg for you?

**Use Marg when** your agent must complete a transaction, not only answer; when the result is
published under a real user's name; when several specialist agents sit behind one entry point;
when you need to prove behaviour before and after every change without burning model credits;
when you are going to run it yourself.

**Look elsewhere when** you want a general library for arbitrary agent graphs, your bot only
answers and never writes, you want a hosted platform, or your stack must be Python end to end.
[Marg and other frameworks](/get-started/compare) says where the line is.

## Frequently asked questions

::: details Which models can I use?
Anthropic, and any OpenAI-compatible endpoint: OpenAI, Ollama, vLLM, Fireworks, Together, DeepSeek, Gemini through its OpenAI-compatible API. A chain of endpoints with failover and a circuit breaker is one environment line, `LLM_CHAIN=openai,anthropic`. The scripted mock model runs everything with no key. [Environment](/run/environment).
:::

::: details What makes Marg different from an agent framework?
Marg is opinionated about one job shape, *collect → validate → confirm → write*, and puts the costly moments in the runtime instead of the prompt. The reader that reads "yes" by the whole message, the three-fold write gate, and the offline eval gate exist because their absence cost something in production. [The pattern](/build/pattern) explains each rule and the failure it answers.
:::

::: details How do I connect my backend?
Through an MCP tool server, in any language: reads, and the triad `validate_*`, `preview_*`, `create_*`. The example domain's server is the reference; probe the real backend before trusting its documentation. [A new domain](/build/new-domain).
:::

::: details How do I prove it still works after a change?
Run the gate: unit tests, the OpenTelemetry check, the scaffold check, the real-write e2e, and the example suite against a writes-off gateway, all on the mock model. Every red is classified before it is fixed. [Evals](/build/evals).
:::

::: details How do I deploy it?
One non-root image, Compose profiles for stores, observability, decisions and the TLS edge, and a Render blueprint for a demo. [Deploy](/run/deploy), then the [production checklist](/run/production-checklist).
:::
