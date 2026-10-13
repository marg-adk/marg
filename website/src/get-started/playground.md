# The playground

The gateway's home page is a playground around the embeddable widget: the conversation in the
centre, your past chats on the left, the live draft on the right. It is exactly what a host
application gets from one `<script>` tag.

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
- **A premature yes.** Type "yes, create it" before the summary. The runtime guard refuses: the
  summary must have been shown for this draft, and the reply must be a plain go-ahead by its
  whole content.
- **Change something.** On the summary, pick a section; the step's own card re-opens
  pre-filled; the summary returns.
- **Reload.** Refresh the page mid-journey. The open ask is drawn again from the transcript.

## Embedding the widget

```html
<script src="http://localhost:8787/widget.js" data-agent-auto></script>
```

Shadow DOM, zero dependencies, streaming replies, chips, forms, cards, tables, media, resume,
nudges, voice notes. Or speak the [client protocol](/components/client-protocol) from your own
app.
