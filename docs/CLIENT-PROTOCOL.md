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
| `GET /api/session/:id/history` | Resume: `{entries:[{role,text,ui}], completion, preview, completed, usage, media, nudge}`. 410 ⇒ start fresh. |
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
event: done        data: {reply, ui, tool_trace, domain, kind?, completion?, usage}
event: error       data: {error, error_id?, degraded?}
```
`kind` names the runtime step that answered a turn without a model call. `completion` ends
the chat: render the end-state card (`label`, `entity_url` only when present), freeze the
composer, keep uploads welcome.

## ui blocks
A reply's `ui` is an array of blocks (types in `@marg/types`). Tapping an option sends its
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

## Errors
`{error, code?, error_id?}`. Codes: `login_required`, `token_expired`, `auth_unavailable`,
`rate_limit` (with `Retry-After`), `usage_cap` (`scope`, `percent`, `resets_in_s`), `completed`.
Unknown-session text is exact ("Unknown session — call /api/session first.") — clients key
their recovery on it.
