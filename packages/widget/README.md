# @marg-adk/widget

The [Marg](https://github.com/marg-adk/marg) chat widget: one `<script>` tag, Shadow DOM, zero
dependencies. Streaming replies, chips, multi-select, lists, cards with inline edit sections,
forms with readable echoes, tables, progress, media tiles, resume after a reload, nudges, voice
notes, uploads. `@marg-adk/gateway` serves it at `/widget.js`; this package is the file plus a manifest.

```html
<script src="http://localhost:8787/widget.js" data-agent-auto></script>
```

Speaks [docs/CLIENT-PROTOCOL.md](https://github.com/marg-adk/marg/blob/main/docs/CLIENT-PROTOCOL.md);
implement it from your own app instead if you prefer.
