# @marg-adk/metering

The client a product embeds to report usage to a metering or billing service, from
[Marg](https://github.com/marg-adk/marg): buffered, idempotent (`event_id`), batched, retried
with backoff, and **fail-open** — a metering outage never blocks a turn. Pass-through by design:
bill what vendors bill you.

```ts
import { MeteringClient } from "@marg-adk/metering";
```

[docs/METERING.md](https://github.com/marg-adk/marg/blob/main/docs/METERING.md).
