# Guide: tools in Python

```bash
npm run new-domain -- bookings --lang python      # marg new bookings --lang python
python3 -m venv .venv && .venv/bin/pip install -r domains/bookings/mcp/requirements.txt
source .venv/bin/activate && npm run gateway       # the gateway spawns python3 → the venv's
```

The runtime is Node; the tools can be Python. `--lang python` scaffolds the same domain as the
TypeScript scaffold — manifest, skill, schema registry, steps, mock policy, evals, probe — with
one difference: the tool server is `mcp/server.py` on the official `mcp` SDK (2.x, `MCPServer`
over stdio) with `mcp/requirements.txt` beside it, and the manifest points at it:

```json
"mcp": { "command": "python3", "args": ["domains/bookings/mcp/server.py"] }
```

The gateway spawns that command as a child process with the repository as its working
directory, exactly as it spawns `npx tsx …/server.ts`. `python3` resolves on the gateway's PATH
at boot: activate the venv first, or set `command` to `.venv/bin/python` (or an absolute path).
Python 3.10 or newer.

## The contract is the same

Everything in [the new-domain guide](new-domain.md) and the playbook holds unchanged; only the
language of one file differs.

- **The triad**: `validate_<entity>_slots` (write-free, called after every slot change; returns
  `problems`, `from_record`, `defaults`), `preview_<entity>`, `create_<entity>` (refuses without
  `confirmed=True` **and** `AGENT_ALLOW_WRITES == "true"`; returns `{"created": true, "entity_id": …}`).
  Slots are flat tool arguments, one parameter each, typed with `Annotated[…, Field(description=…)]`;
  the SDK publishes the JSON schema the model sees and validates calls against it, so a value outside
  a `Literal` comes back as a tool error before your code runs.
- **Auth and session** ride MCP `_meta`, never arguments: `_meta["agent/auth"]` is the user's bearer,
  `_meta["agent/session"]` the chat's session id. The template's `reg()` wrapper reads them from
  `ctx.request_context.meta` and puts them in a context variable (`who()` reads it), so no handler
  takes a token as an argument.
- **Trace context**: the gateway injects W3C `traceparent` / `tracestate` into `_meta`; `reg()`
  extracts it and opens a `mcp.tool <name>` SERVER span with the same attributes as the TypeScript
  server (`rpc.system`, `rpc.method`, `gen_ai.tool.name`, `session.id`, `agent.tool.ok`,
  `agent.tool.ms`). `opentelemetry-api` alone makes that a no-op; see below to export.
- **Results** are text: `ok(data)` returns a text result holding compact JSON, `fail(msg)` an
  `isError` result whose text starts with `ERROR:` — the runtime marks the span, the model reads the reason, the mock policy and
  the evals see the same shapes they see from TypeScript.
- **stdout is the protocol channel.** `log()` writes one JSON line per event to stderr, in the shape
  the gateway's logger writes (`ts`, `level`, `service`, `msg`, fields); the trace line per call logs
  counts and shapes of the arguments, never a user's text. Python's `logging` is pointed at stderr
  too. A stray `print()` to stdout breaks the connection.
- **Handlers** may be `def` or `async def`; `reg()` wraps both. Declare `*, ctx: Context` on every
  handler — the SDK fills it, the wrapper needs it.
- **Internal tools** (`internal_upload_media` and friends) are registered the same way; the gateway
  hides any tool whose name starts with `internal_` from the model.

## Exporting the spans

The template depends on the OpenTelemetry API only, so it runs anywhere. To ship the spans to the
same backend as the gateway, install an SDK and the OTLP exporter and configure a provider before
the tools are registered — the same endpoint and credentials the gateway uses
([observability](../OBSERVABILITY.md)):

```bash
.venv/bin/pip install opentelemetry-sdk opentelemetry-exporter-otlp-proto-http
```

```python
# at the top of mcp/server.py, after the imports
import os
from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

base = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT") or (os.environ.get("AGENT_O2_URL", "").rstrip("/") + "/api/" + os.environ.get("AGENT_O2_ORG", "default"))
if base.startswith("http"):
    headers = {}
    if os.environ.get("AGENT_O2_USER"):
        import base64
        headers["Authorization"] = "Basic " + base64.b64encode(f"{os.environ['AGENT_O2_USER']}:{os.environ.get('AGENT_O2_PASSWORD', '')}".encode()).decode()
    provider = TracerProvider(resource=Resource.create({"service.name": "marg-bookings-mcp", "service.namespace": "marg"}))
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=f"{base}/v1/traces", headers=headers)))
    trace.set_tracer_provider(provider)
```

Or leave the file alone and run it under the auto-instrumentation wrapper: `pip install
opentelemetry-distro opentelemetry-exporter-otlp` and set the manifest's command to
`.venv/bin/opentelemetry-instrument` with args `["python3", "domains/bookings/mcp/server.py"]`;
the standard `OTEL_*` variables configure it.

## Proving it

```bash
SCAFFOLD_LANG=python npm run check:scaffold      # scaffold, typecheck, a venv under .data/, py_compile, gateway, evals
```

The check scaffolds a Python domain, installs its requirements into `.data/venv-scaffold`,
compiles the server, boots a gateway with only that domain (mock model, writes off) and runs the
scaffold's own eval suite — so a template that drifts from the contract fails here. CI runs it on
Python 3.11 as the `scaffold (python 3.11)` job; a change to the template, the scaffolder or the
runtime's `_meta` contract has to keep it green. `SCAFFOLD_PYTHON=/path/to/python3.11` picks the
interpreter when `python3` on PATH is older than 3.10.

Your own domain's suite runs the same way as any other: `npm run gateway:evals &` then
`npx tsx domains/bookings/evals/run-evals.ts`.

## What stays TypeScript

The skill, the steps, the mock policy, the evals and the probe are the runtime's side and stay in
TypeScript — they run inside the gateway and the eval runner, not in your server. A Python backend
can of course sit behind any of them; the probe is a thin HTTP script and reads fine as a model
for a Python one if you prefer.
