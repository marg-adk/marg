# @marg/types

Cross-package types for [Marg](https://github.com/marg-adk/marg): the domain manifest
(`DomainManifest`, what `domain.json` declares), the client protocol (ui blocks, stream events,
preview, completion — [docs/CLIENT-PROTOCOL.md](https://github.com/marg-adk/marg/blob/main/docs/CLIENT-PROTOCOL.md)),
and step state. Types only, no runtime code.

```ts
import type { DomainManifest, StreamEvent, UiBlock } from "@marg/types";
```
