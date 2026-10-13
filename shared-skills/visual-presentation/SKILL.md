---
name: visual-presentation
category: Visual output
description: Visual output protocol for the chat client — when and how to emit ui blocks (chips, multichips, lists, cards, toggles, links) that render as tappable interface elements instead of plain text.
---

# Visual presentation — the `ui` block protocol

The chat surface renders structured blocks natively. To show one, emit a fenced code block with
language `ui` containing ONE JSON object. Text outside the blocks renders as your normal message.
Emit the text first, then the block(s).

## Blocks you may send

**1. Chips — quick replies for short enums (2–8 options):**
```ui
{"type":"chips","options":[{"label":"High","value":"high"},{"label":"Medium","value":"medium"},{"label":"Low","value":"low"}]}
```
Any single-pick enum, yes/no, a magnitude confirmation. The tapped `value` comes back as the
user's message — make values self-describing. The chips must answer the question in the same
message, and only that question.

**2. Multichips — multi-select with a Done button:**
```ui
{"type":"multichips","min":3,"submit":"Done","options":[{"label":"Option A","value":"Option A"},{"label":"Option B","value":"Option B"}]}
```
Any question where the user picks several items. All picked values arrive as one
comma-separated message. Never ask for multi-pick items one at a time.

**3. List — pickable rows with context (search results, record pickers):**
```ui
{"type":"list","items":[{"title":"<primary name>","subtitle":"<disambiguating context>","value":"<self-describing pick>"}]}
```
Disambiguating a reference-data match (≤10 rows — if more, ask them to narrow it).

**4. Card — a record playback or an informational summary:**
```ui
{"type":"card","title":"Ticket — Login fails on mobile","fields":[{"label":"Customer","value":"Acme Ltd"},{"label":"Priority","value":"High (default)"}]}
```
One item per row, every default marked "(default)". **The confirmation summary before a
create is the runtime's** — it draws the card with every row and the Confirm / Change actions
under your reply. Never draw a summary with actions yourself; gather, validate, and stop.

**5. Toggles — on/off switches for a set of fields:**
```ui
{"type":"toggles","submit":"Done","options":[{"label":"Field A","value":"field_a"},{"label":"Field B","value":"field_b","on":true}]}
```

**6. Link — opens an external screen in a new tab:**
```ui
{"type":"link","label":"Open in the app","url":"<URL from a tool result>"}
```
ONLY with a URL a tool result gave you — never invent or guess a URL (the client refuses any
scheme but http/https and the app's own).

## Blocks you never send (the runtime draws them)
`form` (a card of rows the user fills in place), `table`, `progress`, `media` (uploads) and
`bars` are runtime-only. If a runtime fact says a card or picker is open under your reply, your
reply is at most one short line.

## Rules
- Every block is preceded by at least one line of plain text — the text asks, the block offers.
  A user on a broken client must still be able to answer by typing.
- Never put the same information in both text and block.
- Chips for ≤8 short single-pick options; multichips for anything multi-pick; list for rich rows.
  Free-form values (amounts, names, long text) stay text-only — no block.
- Never more than 2 blocks per message. Never nest or combine types in one JSON object.
- Malformed JSON is dropped by the client — keep blocks simple and valid.
