# The playground

The gateway's home page is a playground around the embeddable widget, and the dev UI: one
conversation in the centre (exactly what a host application gets from one `<script>` tag), the
**live draft** on the right (every value with where it came from), and the **trace** beside it.
Both panes collapse; past chats are in a drawer; the empty state offers the domains' own example
openers.

The trace has one entry per turn: who answered (the runtime, or the model, or both when the model
answered and the runtime drew the card under it), the **route** — which domain got the turn, the
link that decided (`keywords`, `llm`…) and its confidence — the **steps** the runtime moved (the
Details card *asked*, *redrawn*, *settled*; the summary shown), every **tool call** folded (click
one to read the arguments it received and the result it returned), the **model's** calls with their
timings, the usage and the create. A refused create shows as `create_ticket` with the refusal in
its result.

That content — arguments, results, the route — is shown only when the gateway runs with
`AGENT_DEV_TRACE=true`, which a project's `.env` sets and the hosted copy leaves off (the pane then
keeps to who answered, the tools and their time, and says why). It goes to your browser, never to
telemetry. The shape is in the [client protocol](/components/client-protocol).

A hosted copy runs at **https://marg-playground.onrender.com** on the mock model with writes
off. It sleeps when idle, so the first load takes a moment, and keeps no disk, so a session may
be lost on a redeploy. Everything else is the real thing.

## What to try

- **The opener.** "ticket for Northwind: login fails on mobile" — one sentence that names the
  customer and the problem. The agent resolves the customer, asks the category, draws the
  Details card.
- **Words beside an open ask.** While the Details card is open, type "what counts as
  production?". The model answers in a line; the card is drawn again under it. A typed "yes"
  while a card is open is never an answer to it.
- **A premature yes.** Type "yes, create it" while the Details card is open. Nothing is created:
  the runtime says the card is still open and draws it again, because a typed yes is never an
  answer to a card, and the create gate requires the summary to have been shown for this draft
  and the reply to be a plain go-ahead by its whole content. The trace pane shows the turn was
  the runtime's, with no tool call.
- **Change something.** On the summary, pick a section; the step's own card re-opens
  pre-filled; the summary returns.
- **Open a tool call.** After the opener, click `search_customers` in the trace: the query it
  was given and the two customers it found.
- **Reload.** Refresh the page mid-journey, or open a finished chat from the drawer. The open ask
  is drawn again from the transcript, the draft comes back with it, and the trace pane has every
  turn again, from the one history request the page makes.

## Embedding the widget

```html
<script src="http://localhost:8787/widget.js" data-agent-auto></script>
```

Shadow DOM, zero dependencies, streaming replies, chips, forms, cards, tables, media, resume,
nudges, voice notes. Or speak the [client protocol](/components/client-protocol) from your own
app.
