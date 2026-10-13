# @marg/verdict

Typed decisions with calibrated probabilities for agents, from [Marg](https://github.com/marg-adk/marg):
`choice` / `noul` / `score` questions answered by rules first, a decision model second (Laya or
any server speaking the System One protocol), and an LLM with logprobs last — a cascade with
abstention and calibration maths, instead of prose you parse.

```ts
import { deciderFromEnv } from "@marg/verdict";
const d = deciderFromEnv();
const r = await d.choice("My payment failed twice", { options: ["billing", "technical", "sales"] });
```

Also a CLI, an MCP server and a System One-compatible HTTP server:
[docs/DECISIONS.md](https://github.com/marg-adk/marg/blob/main/docs/DECISIONS.md).
