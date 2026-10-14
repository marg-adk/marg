# Marg and other frameworks

Marg is not a replacement for a general agent framework. It is the layer you would otherwise
write on top of one when the agent has to finish a job for real users: collect what the backend
needs, validate it, show it, get an explicit yes, write exactly once.

| | Orchestration libraries (graphs, handoffs) | Low-code builders | Marg |
|---|---|---|---|
| Who reads "yes" | the model | the model | the runtime, by the whole message |
| Forms, pickers, confirmation | your UI code, if any | the builder's | drawn and read by the runtime, carried into tool calls |
| Many domains, one entry point | you wire it | one bot per flow | drop-in domains, typed routing, sticky |
| Decisions | prompt and parse | prompt and parse | rules → decision model → logprobs, calibrated |
| Regression gate | your harness | manual | scenario runner, mock model, CI with no key |
| Identity, limits, caps, cost, telemetry | bring your own | platform's | included, model-agnostic |

## Where the line is

**Tool confirmation.** Most frameworks offer a confirmation hook: a tool pauses, the model asks
the user, a dialog answers. The model still reads the reply. On a blind corpus of 521 typed
replies, a reader that looked at the leading word mis-read 235 as a bare yes or no; reading the
whole message mis-read none. Marg's gate is the runtime's, three times over: the skill rule, the
tool schema, the runtime guard. [The pattern](/build/pattern#5-the-write-gate-three-times).

**Human input.** A graph node that pauses for input (an `interrupt`, a `RequestInput`), now
often with a response schema, validates the *shape* of what comes back; the question's wording,
the choice of control and the reading of a typed reply are still the model's or your code's. In
Marg a step draws its ask (a form card, chips, a picker), reads the reply by its whole content,
carries the value into every later tool call, and tells the model one fact. Three helpers cover
most steps. [A new step](/build/new-step).

**Evaluation.** Trajectory and rubric evaluation judge a run after the fact, often with another
model. Marg's scenarios assert what must *always* hold, deterministically, against a writes-off
gateway, on a scripted mock model, so the gate runs in CI with no key. Both have their place;
Marg ships the one that can be a merge gate. [Evals](/build/evals).

**Breadth.** Graph workflows, agent-to-agent protocols, live audio, visual builders and a hundred
integrations are not Marg's job. Marg reaches those ecosystems through MCP (your tools, any
language) and the [client protocol](/components/client-protocol) (any client). Use the general
framework for the general part; put Marg where the write happens.

[The review of adk.dev](/community/reviews/adk-dev-2026-10) goes through one of them in detail.
