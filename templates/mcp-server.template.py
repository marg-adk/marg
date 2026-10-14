"""
mcp/server.py — the __NAME__ MCP server, in Python: every tool the model (and the gateway) can call.

  read-only:  whoami, search_records, reference_data
  triad:      validate___ENTITY___slots → preview___ENTITY__ → create___ENTITY__
  internal:   add internal_upload_media / internal_attach_media / internal_detach_media for media
              (hidden from the model; the gateway calls them — see examples/support-intake)

Conventions every domain keeps (docs/PLAYBOOK.md):
 - validate_* is write-free and is called after EVERY slot-changing turn; it fills what a record
   knows (`from_record`), applies declared defaults (`defaults`) and lists the missing mandatory
   slots as `problems`.
 - create_* refuses without confirmed=True AND without AGENT_ALLOW_WRITES == "true", and returns
   {"created": True, "entity_id": …} — the shape that ends the journey. Never weaken either check.
 - The user's bearer rides in `_meta["agent/auth"]` (never in arguments); the trace context in
   `_meta` joins this server's spans to the gateway's trace. stdout is the protocol channel: log
   to stderr only.

The gateway spawns this file as a child process, exactly as it spawns a TypeScript server
(domain.json: "mcp": { "command": "python3", "args": ["…/mcp/server.py"] }). It needs Python ≥ 3.10
and `pip install -r mcp/requirements.txt`: the official `mcp` SDK (2.x, MCPServer over stdio) and
the OpenTelemetry API. docs/guides/python-tools.md has the venv, the tracing setup and the checks.

Replace the TODO bodies with calls to your backend. Keep the shapes.
"""
from __future__ import annotations

import base64
import contextlib
import contextvars
import functools
import inspect
import json
import logging
import os
import sys
import time
import uuid
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Annotated, Any, Literal

from mcp.server.mcpserver import Context, MCPServer
from mcp.types import CallToolResult, TextContent
from pydantic import Field

# OpenTelemetry is optional: without it the server runs, the gateway's trace just has no child spans.
try:
    from opentelemetry import trace
    from opentelemetry.propagate import extract
    from opentelemetry.trace import SpanKind, Status, StatusCode

    _tracer: Any = trace.get_tracer("__NAME__-mcp")
except ImportError:  # pragma: no cover
    _tracer = None

# The `_meta` keys the gateway sets on every call (packages/core/src/mcp-client.ts). Never rename.
AUTH_META_KEY = "agent/auth"
SESSION_META_KEY = "agent/session"
SERVICE = "__NAME__-mcp"

# stdout is the protocol channel: everything the server says goes to stderr, one JSON line each,
# the shape the gateway's own logger writes.
logging.basicConfig(stream=sys.stderr, level=logging.WARNING)


def log(level: str, msg: str, **fields: Any) -> None:
    line = {"ts": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"), "level": level, "service": SERVICE, "msg": msg}
    line.update({k: v for k, v in fields.items() if v is not None})
    print(json.dumps(line, default=str), file=sys.stderr, flush=True)


def head(text: str, n: int) -> str:
    return text if len(text) <= n else text[: n - 1] + "…"


def summarize(args: dict[str, Any]) -> dict[str, Any]:
    """Counts and shapes only — never a user's text — for the trace line."""
    out: dict[str, Any] = {}
    for k, v in args.items():
        if isinstance(v, bool) or v is None:
            out[k] = v
        elif isinstance(v, (int, float)):
            out[k] = v
        elif isinstance(v, str):
            out[k] = f"str:{len(v)}"
        elif isinstance(v, (list, tuple, set)):
            out[k] = f"list:{len(v)}"
        elif isinstance(v, dict):
            out[k] = f"object:{len(v)}"
        else:
            out[k] = type(v).__name__
    return out


# TODO: your reference data (or fetch it from the backend at boot).
KINDS = ["a", "b"]
PRIORITIES = ["low", "high"]
RECORDS: list[dict[str, str]] = [{"record_id": "rec-1", "name": "Example record"}]

# The slots, once: each tool of the triad takes them flat (the model sends them flat).
Title = Annotated[str | None, Field(description="what this is about, short")]
RecordId = Annotated[str | None, Field(description="from search_records — never invented")]
RecordName = str | None
Kind = Literal[tuple(KINDS)] | None  # type: ignore[valid-type]
Notes = str | None
Priority = Literal[tuple(PRIORITIES)] | None  # type: ignore[valid-type]
Slots = dict[str, Any]


def slots_of(**values: Any) -> Slots:
    """The slots the caller actually sent (None means absent, as an omitted key does in TypeScript)."""
    return {k: v for k, v in values.items() if v is not None}


# ---- per-call auth context ------------------------------------------------------------
_call: contextvars.ContextVar[dict[str, str | None]] = contextvars.ContextVar("call", default={})


def who() -> str:
    token = _call.get().get("token")
    return "user-" + base64.urlsafe_b64encode(token.encode()).decode().rstrip("=")[:6] if token else "demo-user"


def ok(data: Any) -> CallToolResult:
    return CallToolResult(content=[TextContent(type="text", text=json.dumps(data))])


def fail(msg: str) -> CallToolResult:
    return CallToolResult(content=[TextContent(type="text", text=f"ERROR: {msg}")], is_error=True)


def validate(s: Slots) -> dict[str, Any]:
    """Write-free: what is missing, what the record fills, what defaults apply. TODO: mirror your backend's REAL mandatories (probe/probe.ts)."""
    problems: list[str] = []
    from_record: dict[str, str] = {}
    defaults: dict[str, str] = {}
    if not str(s.get("title") or "").strip():
        problems.append("title")
    record = next((r for r in RECORDS if r["record_id"] == s.get("record_id")), None)
    if record:
        from_record["record_name"] = record["name"]
    if s.get("kind") is not None and s["kind"] not in KINDS:
        problems.append(f"kind must be one of {', '.join(KINDS)}")
    if not s.get("priority"):
        defaults["priority"] = "low"
    return {"ok": not problems, "problems": problems, "from_record": from_record, "defaults": defaults}


server = MCPServer("__NAME__", version="0.1.0")


@contextlib.contextmanager
def _span(name: str, meta: dict[str, Any], session: str | None):
    """A SERVER span in the gateway's trace: the W3C context rides `_meta` (traceparent, tracestate)."""
    if _tracer is None:
        yield None
        return
    carrier = {k.lower(): v for k, v in meta.items() if isinstance(v, str)}
    attrs = {"rpc.system": "mcp", "rpc.service": "__NAME__", "rpc.method": name, "gen_ai.tool.name": name}
    if session:
        attrs["session.id"] = session
    with _tracer.start_as_current_span(f"mcp.tool {name}", context=extract(carrier), kind=SpanKind.SERVER, attributes=attrs) as span:
        yield span


def reg(name: str, description: str, **tool_kwargs: Any) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """Register a tool whose handler runs inside the caller's auth context and a SERVER span in the gateway's trace.

    The handler declares `ctx: Context` (keyword-only is fine); the SDK fills it, and this wrapper reads
    the bearer, the session id and the trace context from `ctx.request_context.meta`.
    """

    def decorate(fn: Callable[..., Any]) -> Callable[..., Any]:
        def begin(kwargs: dict[str, Any]) -> tuple[dict[str, Any], str | None, dict[str, Any]]:
            ctx = kwargs.get("ctx")
            meta = dict(ctx.request_context.meta or {}) if ctx is not None else {}
            token = meta.get(AUTH_META_KEY) if isinstance(meta.get(AUTH_META_KEY), str) else None
            session = meta.get(SESSION_META_KEY) if isinstance(meta.get(SESSION_META_KEY), str) else None
            _call.set({"token": token, "session": session})
            return meta, session, {k: v for k, v in kwargs.items() if k != "ctx"}

        def finish(span: Any, session: str | None, t0: float, args: dict[str, Any], out: Any) -> None:
            text = out if isinstance(out, str) else next((c.text for c in getattr(out, "content", []) if getattr(c, "type", "") == "text"), "")
            is_ok = not (getattr(out, "is_error", False) or text.startswith("ERROR"))
            ms = int((time.monotonic() - t0) * 1000)
            if span is not None:
                span.set_attribute("agent.tool.ok", is_ok)
                span.set_attribute("agent.tool.ms", ms)
                if not is_ok:
                    span.set_status(Status(StatusCode.ERROR, head(text, 200)))
            log("trace", "mcp.tool", session=session, tool=name, ms=ms, ok=is_ok, args=summarize(args), result=head(text, 300))

        if inspect.iscoroutinefunction(fn):

            @functools.wraps(fn)
            async def awrapper(*a: Any, **kwargs: Any) -> Any:
                meta, session, args = begin(kwargs)
                t0 = time.monotonic()
                with _span(name, meta, session) as span:
                    try:
                        out = await fn(*a, **kwargs)
                    except Exception as e:
                        log("trace", "mcp.tool", session=session, tool=name, ms=int((time.monotonic() - t0) * 1000), ok=False, error=str(e))
                        raise
                    finish(span, session, t0, args, out)
                    return out

            return server.tool(name=name, description=description, **tool_kwargs)(awrapper)

        @functools.wraps(fn)
        def wrapper(*a: Any, **kwargs: Any) -> Any:
            meta, session, args = begin(kwargs)
            t0 = time.monotonic()
            with _span(name, meta, session) as span:
                try:
                    out = fn(*a, **kwargs)
                except Exception as e:
                    log("trace", "mcp.tool", session=session, tool=name, ms=int((time.monotonic() - t0) * 1000), ok=False, error=str(e))
                    raise
                finish(span, session, t0, args, out)
                return out

        return server.tool(name=name, description=description, **tool_kwargs)(wrapper)

    return decorate


@reg("whoami", "The current user's identity. Call once at session start.")
def whoami(*, ctx: Context) -> CallToolResult:
    return ok({"user_id": who()})


@reg("search_records", "Find records by name. Returns ids + names; the model never invents a record_id. 0 matches ⇒ ask the user to re-check the name; 2+ ⇒ let them pick.")
def search_records(query: Annotated[str, Field(description="part of the record's name")], *, ctx: Context) -> CallToolResult:
    q = str(query or "").strip().lower()
    # TODO: call your backend's search here.
    return ok({"records": [r for r in RECORDS if q in r["name"].lower()] if q else []})


@reg("reference_data", "Option lists: kinds, priorities.")
def reference_data(kind: Literal["kinds", "priorities"], *, ctx: Context) -> CallToolResult:
    return ok({"kind": kind, "options": KINDS if kind == "kinds" else PRIORITIES})


@reg("validate___ENTITY___slots", "Write-free check of the draft. Call after EVERY turn that adds or changes a slot (it fills the live draft pane). Returns problems (missing/invalid), from_record and defaults.")
def validate___ENTITY___slots(title: Title = None, record_id: RecordId = None, record_name: RecordName = None, kind: Kind = None, notes: Notes = None, priority: Priority = None, *, ctx: Context) -> CallToolResult:
    return ok(validate(slots_of(title=title, record_id=record_id, record_name=record_name, kind=kind, notes=notes, priority=priority)))


@reg("preview___ENTITY__", "Compose the full payload WITHOUT saving. Send the complete slot set (it replaces the draft).")
def preview___ENTITY__(title: Title = None, record_id: RecordId = None, record_name: RecordName = None, kind: Kind = None, notes: Notes = None, priority: Priority = None, *, ctx: Context) -> CallToolResult:
    s = slots_of(title=title, record_id=record_id, record_name=record_name, kind=kind, notes=notes, priority=priority)
    v = validate(s)
    return ok({"ok": True, "payload": {**s, **v["from_record"], **v["defaults"]}} if v["ok"] else {"ok": False, "problems": v["problems"]})


@reg("create___ENTITY__", "REAL WRITE — save the __ENTITY__. Only after the user saw the summary and explicitly confirmed; refuses without confirmed:true.")
def create___ENTITY__(
    confirmed: Annotated[bool, Field(description="true only after the user explicitly confirmed the summary")],
    title: Title = None,
    record_id: RecordId = None,
    record_name: RecordName = None,
    kind: Kind = None,
    notes: Notes = None,
    priority: Priority = None,
    *,
    ctx: Context,
) -> CallToolResult:
    if confirmed is not True:
        return fail("refused: user has not confirmed the summary. Show the summary and ask for an explicit yes first.")
    if os.environ.get("AGENT_ALLOW_WRITES") != "true":
        return fail("refused: writes are disabled on this gateway (AGENT_ALLOW_WRITES != true).")
    s = slots_of(title=title, record_id=record_id, record_name=record_name, kind=kind, notes=notes, priority=priority)
    v = validate(s)
    if not v["ok"]:
        return fail("refused: missing or invalid slots — " + "; ".join(v["problems"]))
    # TODO: POST to your backend and return ITS id. Until then a local id keeps the journey runnable.
    entity_id = "__ENTITY__"[:3].upper() + "-" + uuid.uuid4().hex[:6].upper()
    tmpl = os.environ.get("AGENT_ENTITY_DEEPLINK")
    return ok({"created": True, "entity_id": entity_id, "label": f"__ENTITY__ {entity_id}", "entity_url": tmpl.replace("{entity_id}", entity_id) if tmpl else None})


if __name__ == "__main__":
    log("info", "__NAME__ MCP ready", writes=os.environ.get("AGENT_ALLOW_WRITES") == "true", python=sys.version.split()[0])
    server.run()  # stdio
