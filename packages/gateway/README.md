# @marg-adk/gateway

The HTTP/SSE server of a [Marg](https://github.com/marg-adk/marg) agent — the only thing clients
talk to: sessions with verified identity and owner checks, chat turns (JSON or streamed), the
super-agent router (one domain per turn, a typed decision), rate limits, usage caps, media, voice,
nudges, health and metrics, graceful shutdown. It discovers domains under `domains/` and
`examples/` in the working directory and serves the widget and the playground.

```bash
npx marg-gateway            # or "gateway": "marg-gateway" in package.json — http://localhost:8787
```

Configuration is the environment (`.env` in the working directory):
[docs/ENVIRONMENT.md](https://github.com/marg-adk/marg/blob/main/docs/ENVIRONMENT.md). Start a
project with `npx create-marg-app my-agent`.
