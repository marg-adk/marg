# The client protocol

Everything a client (the widget, a web view, a native app) needs. The widget in
`packages/widget` implements all of it; a native client implements the same calls.

## Authentication
- Every `/api/*` call except `/api/health` and `/api/auth/exchange` carries `Authorization:
  Bearer <token>` when login is on. The token is either an **agent token** from
  `POST /api/auth/exchange` (preferred — docs/SDK-AUTH.md) or your upstream token, verified
  strictly. 401 `login_required` / `token_expired`, 503 `auth_unavailable`.
- Optional embed gating: `X-Agent-Key: <gateway key>`.

## Endpoints
| Method & path | Purpose |
|---|---|
| `POST /api/session` | Create a chat → `{session_id, nudge, brand}`. Store the id (localStorage) to resume. |
| `POST /api/chat` | One turn, JSON: `{session_id, message, display?}` → `AgentReply` |
| `POST /api/chat/stream` | The same turn as Server-Sent Events (below) |
| `POST /api/chat/voice` | Raw audio in (`Content-Type: audio/*`, `X-Agent-Session`), SSE out starting with `transcript` |
| `POST /api/transcribe` | Transcription only |
| `GET /api/session/:id/history` | Resume: `{entries:[{role,text,ui}], completion, preview, completed, usage, media, nudge}`, plus `turns` when the dev trace is on ([below](#the-dev-trace)). 410 ⇒ start fresh. |
| `GET /api/session/:id/events` | Long-lived SSE for server-initiated events (`ready`, `nudge`, heartbeats) |
| `GET /api/session/:id/usage` | Token usage and cap standings (percentages) |
| `GET /api/my/sessions` | The caller's chats (metadata + a short preview) |
| `DELETE /api/session/:id` | Delete a chat (owner) |
| `POST / GET / PATCH / DELETE /api/media` | Upload one file (raw body, `X-Agent-Session`, `X-Agent-Filename`), list, arrange (`{order, labels, cover}`), remove (`?key=`) |
| `GET /api/health` | Readiness + configuration summary (no secrets) |
| `GET /widget.js` | The embeddable client |

## Stream events (`/api/chat/stream`)
```
event: transcript  data: {text, language, confidence, duration_s}   (voice only, first)
event: delta       data: {text}                                      prose, word by word; ui fences never stream
event: tool        data: {name}                                      a tool started (show a status line)
event: preview     data: PreviewState                                the draft: slots, missing, state, defaults, steps…
event: done        data: {reply, ui, tool_trace, domain, kind?, completion?, usage, trace?}
event: error       data: {error, error_id?, degraded?}
```
`kind` names the runtime step that answered a turn without a model call. `completion` ends
the chat: render the end-state card (`label`, `entity_url` only when present), freeze the
composer, keep uploads welcome. `trace` is the dev trace: present only when the gateway runs
with `AGENT_DEV_TRACE=true`, and the same object rides the JSON reply of `POST /api/chat`.

## The dev trace
A dev UI (the playground) needs more than `tool_trace`'s `{tool, ms}`: the route decision, each
step's state, a tool call's arguments and result, the model's timings. The gateway has all of it
per turn; it hands it to a client only when it runs as the dev UI.

**The flag.** `AGENT_DEV_TRACE=true` (the literal string; default off). `.env.example` sets it on;
`render.yaml` and `.env.production.example` leave it off. `GET /api/health` reports
`dev_trace: true|false`, so a client can say why a pane is bare. With the flag off nothing below is
sent and nothing is kept: `trace` is absent from `done` and the JSON reply, `turns` is absent from
`/history`. **Content never reaches telemetry**: spans, metrics and `behaviour.*` events keep their
labels (counts and enums); the dev trace is a client payload, never a span attribute.

**`trace`** — one per turn, additive on `done` and on the JSON reply:

```
{
  turn: 4,                                    // the session's turn counter (the trace log lines' join key)
  route: {                                    // who got the turn, and why
    domain: "support-intake",
    by: "keywords",                           // the deciding link: keywords | systemone | llm, or
                                              // sticky (mid-journey, finished, or a low-confidence pick
                                              // kept the active domain), single (one domain installed),
                                              // fallback (nothing decided; the first domain)
    confidence?: 0.9                          // the router's typed decision, when one was made
  },
  steps: [                                    // the step engine's events this turn, in order
    { step: "details", event: "settled", via: "answer" }
  ],                                          // event: drawn | late_draw | redrawn | reopened | settled
                                              //        | skipped | reset (an edit changed what it depends on)
                                              //        | summary (the confirmation card, step "confirm")
  tools: [                                    // every tool call, in order
    { name: "search_customers", args: {query: "Northwind"}, result: "[{…}]", ms: 41,
      ok: true, carried?: ["customer_id"], refused?: "confirm_gate", runtime?: true }
  ],
  llm: [                                      // one per model call (none on a runtime-answered turn)
    { round: 0, endpoint: "mock", model: "mock-1", ms: 812, ttft_ms?: 240, input: 1630, output: 64,
      finish: "tool_calls" }                  // finish: stop | tool_calls
  ]
}
```

`args` is the object the tool received (after the runtime's carry rule: `carried` lists the keys it
restored), strings clipped, secrets and phone-like numbers masked; `result` is the tool's text,
masked and clipped to 2,000 characters. The user's token is never in either: it rides `_meta`.

**`turns` on `/history`** — the same facts for every turn the session has had, so a reload rebuilds
the Trace pane from one request (the Draft pane comes from `preview`, already in the response):

```
turns: [{ turn, user, display?, ms, domain, kind?, tool_trace, usage?, completion?, trace }]
```

`user` is the message (clipped), `display` what the bubble showed for a form reply. The gateway keeps
the last 30 turns of a session, only while the flag is on; a session from before the flag has none
and a client shows an empty pane, not an error.

## ui blocks
A reply's `ui` is an array of blocks (types in `@marg-adk/types`). Tapping an option sends its
`value` as the user's next message; a form submit sends `"Label [key]: value; …"` plus a
readable `display`. Block families:

- `chips` (single pick; `ghost`, `sel`, `disabled`, `limit`), `multichips` (`min`, `max`,
  `submit`, `own {max}`, `page`, `skip`), `list` (rows with `title`/`subtitle`/`value`).
- `card` (`title`, `fields [{label, value, source}]`, `actions`, `sections` — the review's
  per-section edit chips). The runtime's summary card carries `confirm: true`.
- `form` (`rows [{key, label, kind: pick|multi|text|num|area, options, value, required,
  hint, source, unit, error, say}]`, `submit`, `echo`, `skip`). Required rows gate the submit;
  an option's `fills` sets other rows.
- `toggles` (`options [{label, value, on}]`, `hint`, `wire {prefix, none}`).
- `link` (`label`, `url` — http/https or your app's scheme only).
- Runtime-only: `table`, `progress`, `media`, `bars`.
- Every block may carry `step: "<key>"` — which runtime step drew it (evals and clients key on it).

## Resume, nudges, completion
- Store the session id; on load call `/history` and replay `entries`; the last assistant entry
  carries the open ask's block again, so the user can answer after a refresh.
- Open `/events` to receive nudges live; they are also persisted into the transcript.
- A finished chat answers 409 to a new turn; "start another" = a new session.

## Media
Upload immediately (one request per file, raw bytes); the gateway holds keys on the session,
attaches them the instant the write returns an id, and keeps accepting uploads after completion.
`GET /api/media` → `{file_base, items:[{key, kind, url?, filename, label?, cover, attached}], attached_to}`;
an image loads from `file_base + "/" + key` when no `url` is given.

## Voice
Record a note, POST the bytes; the stream opens with `transcript`, then the normal events. The
note IS the message (no edit step); STT runs server-side so keys never reach the client.

## Embedding the widget

```html
<script src="https://your-gateway/widget.js" data-agent-auto></script>
```

or `AgentChat.init(opts)` from your own script. The options that shape how it sits in a page:

| Option | What |
|---|---|
| `inline` | a selector or element to render into, full size; otherwise a floating bubble |
| `header` | `false` hides the widget's own title bar — for a host page with its own chrome (the playground) |
| `title`, `accent`, `greeting`, `starters` | the title bar text, the brand colour, the first message, chips shown with it |
| `token` | a user Bearer token, or a function returning the current one (docs/SDK-AUTH.md) |
| `onSession(id)` | the active session changed (or `null` on reset) |
| `onPreview(state)` | the host draws the live draft; the widget renders no pane of its own |
| `onTurn(turn)` | after every completed turn: `{user, display, ms, domain, kind, tool_trace, usage, completion, reply, ui, trace}` — what the playground's trace pane shows; `trace` is the [dev trace](#the-dev-trace), `null` when the gateway does not send it |
| `onHistory(history)` | a chat was resumed or opened: the whole `/history` response (`preview`, `completion`, `turns`…), so a host can rebuild its panes from the request the widget already made |
| `linkSchemes` | URL schemes a `link` block may open besides http(s) |

`AgentChat.open()`, `newChat()` and `openSession(id)` are the public methods.

## Errors
`{error, code?, error_id?}`. Codes: `login_required`, `token_expired`, `auth_unavailable`,
`rate_limit` (with `Retry-After`), `usage_cap` (`scope`, `percent`, `resets_in_s`), `completed`.
Unknown-session text is exact ("Unknown session — call /api/session first.") — clients key
their recovery on it.
