# @marg/evals

The regression gate for [Marg](https://github.com/marg-adk/marg) agents: scripted conversations
replayed against a gateway started with writes OFF, deterministic checks per turn (reply or ui
matches, a tool called or never called, the draft's state, the reload redraw), sharding, reruns,
flake classification, and a gate report whose exit code is CI's.

```ts
import { runSuite, replyOrUiMatches, toolCalled, neverTool, type Scenario } from "@marg/evals";
```

Works against any gateway that speaks the client protocol. The example suite and the template
are the reference: [docs/guides/evals.md](https://github.com/marg-adk/marg/blob/main/docs/guides/evals.md).
