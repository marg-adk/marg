# @marg-adk/core

The [Marg](https://github.com/marg-adk/marg) runtime: the domain-agnostic agent loop. Prompt
assembly from markdown skills, the model chain (Anthropic, any OpenAI-compatible endpoint, a
scripted mock) with failover and a breaker, MCP tools over stdio, sessions and durable stores,
**runtime-owned steps** (forms, chips, pickers, the summary, the create gate), whole-content
readers (`readYesNo`, `readChoice`, `readAmount`), guards, and the OpenTelemetry seam.

```ts
import { stepHelpers, readYesNo, type StepDefinition } from "@marg-adk/core";
```

Most projects never import it directly: `@marg-adk/gateway` runs it, and a domain's `steps/index.ts`
uses `stepHelpers`. Start with `npx create-marg-app my-agent`. Guides: the pattern, readers, new
steps — in [docs/](https://github.com/marg-adk/marg/tree/main/docs).
