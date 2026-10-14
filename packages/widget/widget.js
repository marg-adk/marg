/*!
 * Marg chat widget v0.3 — the embeddable client of a Marg gateway (packages/gateway).
 * Embed in any web page / PWA:
 *   <script src="http://localhost:8787/widget.js" data-agent-auto></script>
 * or programmatically:
 *   AgentChat.init({ gateway: "http://localhost:8787", title: "Assistant", accent: "#1a56db" })
 * No framework, no dependencies; renders inside Shadow DOM so host CSS can't leak in.
 *
 * v0.2 UX: multichips (multi-select + Done), stale-control disabling,
 * progress status while the agent works, session auto-recovery.
 */
/*
 * ============================== READER'S GUIDE ==============================
 * WHAT THIS FILE IS
 *   This is the embeddable chat widget: a single plain-JavaScript file that any
 *   host web page can load with one <script> tag. It draws the whole chat UI
 *   (floating bubble, chat panel, message bubbles, tappable chips/cards, mic
 *   button) and talks to the gateway over plain HTTP.
 *
 * KEY BROWSER IDEAS USED BELOW (worth knowing before reading on):
 *   - IIFE: the whole file is wrapped in `(function () { ... })()` — an
 *     "Immediately Invoked Function Expression". It runs once on load and keeps
 *     every variable private, so nothing leaks into the host page except the
 *     single global `window.AgentChat` we deliberately expose at the bottom.
 *   - Shadow DOM: we render the UI inside `host.attachShadow(...)`, a sealed
 *     mini-document attached to one element. The host page's CSS cannot style
 *     our elements and ours cannot leak out — that is what makes the widget
 *     safe to drop into ANY page.
 *   - SSE (Server-Sent Events): a streaming HTTP response where the server
 *     keeps the connection open and sends text "frames" like
 *     `event: delta\ndata: {...}\n\n`. We read it with fetch() +
 *     ReadableStream and parse frames ourselves (see _streamChat/_parseSse).
 *   - localStorage: a tiny per-origin key/value store in the browser that
 *     survives page reloads. We keep the session id there so a user who
 *     closes the tab can resume the same chat later.
 *   - MediaRecorder: the browser API that captures microphone audio into a
 *     Blob (a chunk of binary data) — used for WhatsApp-style voice notes.
 *
 * DATA FLOW, END TO END (one text turn):
 *   user types -> _send() -> POST /api/chat/stream (JSON: session_id +
 *   message) -> gateway runs the agent -> SSE events stream back:
 *     "delta"  = next piece of reply text  -> appended to a live bot bubble
 *     "tool"   = agent is running a tool   -> update the small status line
 *     "preview"= live draft state  -> opts.onPreview (host page owns
 *                the UI, e.g. demo.html's right column) or the widget's own
 *                docked pane behind the 🏠 header toggle (#preview)
 *     "done"   = final clean reply + "ui" blocks (chips/cards) + token usage
 *   -> _renderUi() draws the tappable controls; tapping one just calls
 *   _send() with that value, and the cycle repeats.
 *
 * ENDPOINTS THIS FILE CALLS ON THE GATEWAY:
 *   POST /api/session                  create a chat session (returns session_id)
 *   POST /api/chat/stream              send a text turn, reply streams via SSE
 *   POST /api/chat                     same, non-streaming JSON (old browsers)
 *   POST /api/chat/voice               send recorded audio, reply streams via SSE
 *   GET  /api/session/:id/history      fetch a transcript to resume a chat
 *   GET  /api/session/:id/events       long-lived SSE stream for server nudges
 *   POST /api/media                    upload one photo/video (raw bytes)
 *   GET  /api/media                    what this chat has already uploaded
 * ===========================================================================
 */
(function () {
  "use strict";

  // The origin (scheme + host + port, e.g. "http://localhost:8787") that this
  // very script file was loaded from. `document.currentScript` is the <script>
  // element executing right now; its `src` tells us where the gateway lives,
  // so the widget can default to talking to the same server that served it.
  var SCRIPT_ORIGIN = (function () {
    try {
      var s = document.currentScript;
      return s ? new URL(s.src).origin : "";
    } catch (e) {
      return "";
    }
  })();

  /**
   * Tiny DOM-building helper — the widget's one-line replacement for a UI
   * framework. Creates an element, applies attributes, and appends children.
   * Special attribute keys:
   *   - "text"   -> sets textContent (safe: never parsed as HTML)
   *   - "onXXX"  -> attaches an event listener (e.g. onclick: fn)
   *   - anything else -> a plain HTML attribute via setAttribute
   * @param {string} tag        element name, e.g. "div", "button"
   * @param {Object} [attrs]    attributes / text / event handlers
   * @param {Element[]} [children] child elements to append, in order
   * @returns {Element} the newly created element (not yet in the page)
   */
  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "text") el.textContent = attrs[k];
      else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), attrs[k]);
      else el.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { el.appendChild(c); });
    return el;
  }

  // minimal markdown: **bold**, `code`, newlines. Everything inserted as text nodes (no innerHTML of model output).
  /**
   * Renders the agent's reply text into a bubble with minimal formatting.
   * Security note for the reader: the model's output is untrusted, so we NEVER
   * use innerHTML on it — every piece becomes a text node or a <b>/<code>
   * element built from text, which the browser cannot execute as HTML/script.
   * The regex walks each line finding **bold** and `code` tokens; plain text
   * between tokens is appended as-is; "\n" becomes a <br>.
   * @param {Element} target element to append the formatted nodes into
   * @param {string} text    raw reply text from the agent
   */
  function renderRichText(target, text) {
    text.split("\n").forEach(function (line, i) {
      if (i > 0) target.appendChild(document.createElement("br"));
      var re = /(\*\*[^*]+\*\*|`[^`]+`)/g, last = 0, m;
      while ((m = re.exec(line))) {
        if (m.index > last) target.appendChild(document.createTextNode(line.slice(last, m.index)));
        var tok = m[0];
        if (tok.charAt(0) === "*") target.appendChild(h("b", { text: tok.slice(2, -2) }));
        else target.appendChild(h("code", { text: tok.slice(1, -1) }));
        last = m.index + tok.length;
      }
      if (last < line.length) target.appendChild(document.createTextNode(line.slice(last)));
    });
  }

  // All of the widget's styles as one string, injected into the Shadow DOM as
  // a <style> tag in _mount(). Because it lives inside the shadow root it can
  // only style the widget — host-page CSS and this CSS never mix.
  // ":host{all:initial}" resets every inherited style at the shadow boundary,
  // and "--accent" is a CSS variable set from the configured brand colour.
  var CSS = [
    ":host{all:initial}",
    "*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}",
    ".bubble{position:fixed;bottom:24px;right:24px;width:56px;height:56px;border-radius:50%;background:var(--accent);color:#fff;border:none;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25);font-size:24px;z-index:2147483000;display:flex;align-items:center;justify-content:center}",
    ".panel{position:fixed;bottom:92px;right:24px;width:min(380px,calc(100vw - 32px));height:min(560px,calc(100vh - 120px));background:#fff;border-radius:16px;box-shadow:0 8px 40px rgba(0,0,0,.28);display:none;flex-direction:column;overflow:hidden;z-index:2147483000}",
    ".panel.open{display:flex}",
    ".panel.inline{position:static;width:100%;height:100%;border-radius:0;box-shadow:none}",
    ".head{background:var(--accent);color:#fff;padding:14px 16px;font-size:15px;font-weight:600;display:flex;justify-content:space-between;align-items:center}",
    ".head.mini{background:none;padding:6px 10px;justify-content:flex-end}",
    ".head button{background:none;border:none;color:#fff;font-size:18px;cursor:pointer}",
    ".msgs{flex:1;overflow-y:auto;padding:12px;background:#f6f7f9}",
    ".msg{max-width:85%;width:fit-content;margin:6px 0;padding:9px 12px;border-radius:12px;font-size:13.5px;line-height:1.45;white-space:pre-wrap;word-wrap:break-word}",
    ".msg.user{background:var(--accent);color:#fff;margin-left:auto;border-bottom-right-radius:4px}",
    ".msg.bot{background:#fff;color:#1a1a1a;border:1px solid #e5e7eb;border-bottom-left-radius:4px}",
    ".msg.err{background:#fef2f2;color:#b91c1c;border:1px solid #fecaca}",
    ".chips{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0;align-items:center}",
    ".chip{background:#fff;border:1.5px solid var(--accent);color:var(--accent);border-radius:999px;padding:6px 13px;font-size:12.5px;cursor:pointer;font-weight:500}",
    ".chip:hover{background:#f2f2f2}",
    ".chip.sel{background:var(--accent);color:#fff}",
    ".done{background:var(--accent);color:#fff;border:none;border-radius:999px;padding:7px 15px;font-size:12.5px;cursor:pointer;font-weight:700}",
    ".done:disabled{opacity:.4;cursor:default}",
    ".hint{width:100%;font-size:11px;color:#6b7280;margin:2px 2px 0}",
    ".used{pointer-events:none;opacity:.55}",
    // Live draft preview pane (#preview): hidden until the user taps
    // the 🏠 header button (host pages with onPreview render their own UI
    // instead). Filled in by `preview` SSE events as slots are captured.
    ".pvbtn{display:none}",
    ".pvbtn.on{display:inline}",
    ".pv{background:#fff;border-bottom:1px solid #e5e7eb;font-size:12px;flex:none}",
    ".pv-h{display:flex;align-items:center;gap:6px;padding:7px 12px;cursor:pointer;font-weight:600;color:#374151}",
    ".pv-h .car{margin-left:2px;font-size:9px;color:#9ca3af}",
    ".pv-h .st{margin-left:auto;font-weight:500;font-size:11px;color:#6b7280}",
    ".pv-h .st.ok{color:#059669}",
    ".pv-b{display:none;padding:0 12px 8px;max-height:180px;overflow-y:auto}",
    ".pv.open .pv-b{display:block}",
    ".pv-f{display:flex;justify-content:space-between;gap:10px;padding:2px 0}",
    ".pv-f .k{color:#6b7280;flex:none}",
    ".pv-f .v{font-weight:500;text-align:right;word-break:break-word}",
    ".pv-f.hid .v{color:#9ca3af}", // masked on the public record 
    ".pv-m{margin-top:4px;font-size:11px;color:#b45309}",
    // Draft privacy note (#draft-note) + hidden-fields strip .
    ".pv-note{margin:2px 0 6px;font-size:11px;color:#374151;background:#f3f4f6;border-radius:6px;padding:4px 8px}",
    ".pv-hid{margin-top:4px;font-size:11px;color:#6b7280}",
    ".secondary-pill{background:#fff;border:1.5px solid var(--accent);color:var(--accent);border-radius:999px;padding:6px 14px;font-size:12.5px;cursor:pointer;font-weight:600}",
    // Hide/show toggle rows : field label + switch; ON = hidden.
    ".toggles{background:#fff;border:1px solid #e5e7eb;border-radius:12px;margin:6px 0;padding:4px 12px;max-width:92%}",
    ".tg-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid #f3f4f6}",
    ".tg-row:last-child{border-bottom:none}",
    ".tg-l{font-size:13px;font-weight:500;color:#1a1a1a}",
    ".tg{width:40px;height:22px;border-radius:999px;border:none;background:#d1d5db;position:relative;cursor:pointer;flex:none;padding:0;transition:background .15s}",
    ".tg.on{background:var(--accent)}",
    ".tg i{position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;transition:left .15s}",
    ".tg.on i{left:20px}",
    ".secondary-pill:hover{background:#f2f2f2}",
    ".ended{margin:10px 0 2px;padding:12px;border:1px solid #e5e7eb;border-radius:12px;background:#f9fafb}",
    ".ended-t{font-weight:700;font-size:13px;margin-bottom:8px}",
    ".card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;margin:6px 0;max-width:92%;overflow:hidden}",
    ".card .ct{padding:10px 14px;font-weight:600;font-size:13.5px;border-bottom:1px solid #f0f1f3}",
    ".card .cf{display:flex;justify-content:space-between;gap:10px;padding:6px 14px;font-size:12.5px}",
    ".card .cf .k{color:#6b7280}",
    ".card .cf .v{font-weight:500;text-align:right}",
    ".card .ca{display:flex;gap:8px;padding:10px 14px;border-top:1px solid #f0f1f3}",
    ".card .ca button{flex:1;border-radius:8px;padding:8px 0;font-size:13px;cursor:pointer;font-weight:600;border:1.5px solid var(--accent)}",
    ".card .ca button.primary{background:var(--accent);color:#fff}",
    ".card .ca button.secondary{background:#fff;color:var(--accent)}",
    ".list{margin:6px 0;max-width:92%}",
    ".list .li{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:9px 12px;margin:4px 0;cursor:pointer}",
    ".list .li:hover{border-color:var(--accent)}",
    ".list .li .t{font-size:13px;font-weight:600}",
    ".list .li .s{font-size:11.5px;color:#6b7280;margin-top:2px}",
    ".typing{display:inline-flex;gap:4px;padding:10px 12px}",
    ".typing i{width:6px;height:6px;border-radius:50%;background:#9ca3af;animation:rz 1.1s infinite}",
    ".typing i:nth-child(2){animation-delay:.15s}.typing i:nth-child(3){animation-delay:.3s}",
    "@keyframes rz{0%,60%,100%{opacity:.3}30%{opacity:1}}",
    ".status{font-size:11px;color:#6b7280;padding:0 4px 6px;font-style:italic}",
    ".foot{display:flex;gap:8px;padding:10px;background:#fff;border-top:1px solid #e5e7eb}",
    ".foot textarea{flex:1;resize:none;border:1px solid #d1d5db;border-radius:10px;padding:9px 12px;font-size:13.5px;max-height:90px;outline:none}",
    ".foot textarea:focus{border-color:var(--accent)}",
    ".foot button{background:var(--accent);color:#fff;border:none;border-radius:10px;padding:0 16px;cursor:pointer;font-size:15px}",
    ".foot button:disabled{opacity:.5;cursor:default}",
    ".foot .mic{background:#fff;border:1.5px solid #d1d5db;color:#374151;border-radius:10px;padding:0 12px;font-size:15px}",
    ".voice{display:flex;align-items:center;gap:9px;min-width:190px;padding:2px 0}",
    ".voice .play{width:30px;height:30px;border-radius:50%;border:none;background:rgba(255,255,255,.25);color:#fff;font-size:13px;cursor:pointer;flex:none;display:flex;align-items:center;justify-content:center}",
    ".voice .track{flex:1;height:3px;background:rgba(255,255,255,.35);border-radius:2px;overflow:hidden}",
    ".voice .fill{height:100%;width:0%;background:#fff;border-radius:2px}",
    ".voice .time{font-size:11px;opacity:.9;flex:none;min-width:32px;text-align:right}",
    ".foot .mic.rec{background:#fee2e2;border-color:#ef4444;color:#b91c1c;animation:rzpulse 1.2s infinite}",
    ".foot .mic.busy{opacity:.5;pointer-events:none}",
    "@keyframes rzpulse{0%,100%{box-shadow:0 0 0 0 rgba(239,68,68,.45)}50%{box-shadow:0 0 0 6px rgba(239,68,68,0)}}",
    ".foot .clip{background:#fff;border:1.5px solid #d1d5db;color:#374151;border-radius:10px;padding:0 12px;font-size:15px}",
    ".foot .clip.busy{opacity:.55;pointer-events:none}",
    ".media{display:none;flex-wrap:wrap;gap:6px;align-items:center;padding:8px 10px 0;background:#fff}",
    ".media.on{display:flex}",
    ".media .thumb{position:relative;width:46px;height:46px;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb;background:#f3f4f6;display:flex;align-items:center;justify-content:center;font-size:18px}",
    ".media .thumb img{width:100%;height:100%;object-fit:cover;display:block}",
    ".media .thumb .ov{position:absolute;left:0;right:0;top:0;bottom:0;background:rgba(255,255,255,.72);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#374151}",
    ".media .thumb.err{border-color:#fecaca}",
    ".media .thumb.err .ov{background:rgba(254,242,242,.92);color:#b91c1c}",
    // Remove-photo badge (#media-delete): appears once the upload has a server key.
    ".media .thumb .x{position:absolute;top:1px;right:1px;width:16px;height:16px;border-radius:50%;background:rgba(0,0,0,.65);color:#fff;border:none;font-size:10px;line-height:1;cursor:pointer;display:grid;place-items:center;padding:0}",
    ".media .thumb .x:hover{background:rgba(185,28,28,.9)}",
    ".media .thumb.busy .x{display:none}",
    ".media .mnote{width:100%;font-size:10.5px;color:#6b7280;margin-top:1px}",
    ".usage{display:none;justify-content:space-between;gap:8px;font-size:10.5px;color:#9ca3af;padding:0 14px 7px;background:#fff}",
    ".usage.on{display:flex}",
    ".usage .warn{color:#b45309;font-weight:600}",
    ".chip.ghost{background:#fff;border-style:dashed;color:#6b7280}",
    ".chip.sel{background:var(--accent);color:#fff;border-color:var(--accent)}",
    ".chip.off{opacity:.45;cursor:default}",
    ".chip.own{border-color:#a7f3d0;background:#ecfdf5}",
    ".chip.mini{font-size:11px;padding:3px 9px}",
    ".chip .sug{color:#d97706;font-size:10px}",
    ".chips.multi .mfoot{width:100%;display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:4px}",
    ".chips.multi .cnt{font-size:11px;color:#6b7280;margin-right:auto}",
    ".chips.multi .own{width:100%;display:flex;gap:6px;margin-top:4px}",
    ".chips.multi .own input{flex:1;border:1px solid #d1d5db;border-radius:8px;padding:6px 10px;font-size:13px;outline:none}",
    ".card.compact{border-style:dashed}",
    ".card .secs{display:flex;flex-wrap:wrap;gap:6px;padding:8px 14px 2px}",
    ".src{font-size:9.5px;text-transform:uppercase;letter-spacing:.04em;border-radius:999px;padding:1px 7px;border:1px solid #e5e7eb;color:#6b7280;margin-left:6px}",
    ".src.record{border-color:#bfdbfe;background:#eff6ff;color:#1d4ed8}",
    ".src.heard{border-color:#bbf7d0;background:#f0fdf4;color:#15803d}",
    ".src.inferred,.src.default,.src.runtime{border-color:#fde68a;background:#fffbeb;color:#b45309}",
    ".form{background:#fff;border:1px solid #e5e7eb;border-radius:12px;margin:6px 0;max-width:92%;overflow:hidden}",
    ".form .ct{padding:10px 14px;font-weight:600;font-size:13.5px;border-bottom:1px solid #f0f1f3}",
    ".form .fr{padding:8px 14px;border-bottom:1px solid #f3f4f6}",
    ".form .fr:last-of-type{border-bottom:none}",
    ".form .fh{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px}",
    ".form .fl{font-size:12px;color:#6b7280;font-weight:500}",
    ".form .fo{margin:0}",
    ".form .fi{width:100%;box-sizing:border-box;border:1px solid #d1d5db;border-radius:8px;padding:7px 10px;font-size:13px;outline:none}",
    ".form .fi:focus{border-color:var(--accent)}",
    ".form .fr.bad{background:#fef2f2;box-shadow:inset 3px 0 0 #dc2626}",
    ".form .fr.bad .fi{border-color:#fca5a5}",
    ".form .ferr{font-size:11px;font-weight:500;color:#b91c1c;margin:3px 2px 0}",
    ".form .ca{display:flex;gap:8px;padding:10px 14px;border-top:1px solid #f0f1f3}",
    ".form .ca button{flex:1;border-radius:8px;padding:8px 0;font-size:13px;cursor:pointer;font-weight:600;border:1.5px solid var(--accent)}",
    ".form .ca button.primary{background:var(--accent);color:#fff}",
    ".form .ca button.primary:disabled{opacity:.45;cursor:default}",
    ".form .ca button.secondary{background:#fff;color:var(--accent)}",
    ".tbl{background:#fff;border:1px solid #e5e7eb;border-radius:12px;margin:6px 0;max-width:100%;overflow:hidden}",
    ".tbl .tt,.bars .tt{padding:10px 14px 6px;font-weight:600;font-size:13.5px}",
    ".tbl .ts{overflow-x:auto}",
    ".tbl table{width:100%;border-collapse:collapse;font-size:12px}",
    ".tbl th{text-align:left;font-weight:600;color:#6b7280;font-size:10.5px;text-transform:uppercase;letter-spacing:.02em;padding:6px 8px;border-top:1px solid #f0f1f3;white-space:nowrap}",
    ".tbl td{padding:7px 8px;border-top:1px solid #f0f1f3;white-space:nowrap;font-variant-numeric:tabular-nums}",
    ".tbl th:first-child,.tbl td:first-child{padding-left:14px}",
    ".tbl td.num{text-align:right;font-weight:500}",
    ".tbl.dense table{font-size:10px}",
    ".bn{font-size:11px;color:#6b7280;padding:6px 14px 10px}",
    ".prog{background:#fff;border:1px solid #e5e7eb;border-radius:12px;margin:6px 0;max-width:92%;padding:10px 14px}",
    ".prog .pt{font-weight:600;font-size:13.5px;display:flex;justify-content:space-between;align-items:center}",
    ".prog .st{font-size:10px;text-transform:uppercase;letter-spacing:.04em;border-radius:999px;padding:2px 8px;background:#f3f4f6;color:#6b7280}",
    ".prog .st.ready{background:#ecfdf5;color:#047857}",
    ".prog .st.failed{background:#fef2f2;color:#b91c1c}",
    ".prog .bar{height:6px;background:#f3f4f6;border-radius:999px;margin:8px 0;overflow:hidden}",
    ".prog .bar i{display:block;height:100%;background:var(--accent)}",
    ".prog .stg{font-size:12px;color:#374151}",
    ".mediab{background:#fff;border:1px solid #e5e7eb;border-radius:12px;margin:6px 0;max-width:92%;overflow:hidden}",
    ".mediab .ct{padding:10px 14px;font-weight:600;font-size:13.5px;border-bottom:1px solid #f0f1f3;display:flex;justify-content:space-between;align-items:center}",
    ".mediab .cnt{font-size:11px;color:#6b7280;font-weight:400}",
    ".mediab .grid{display:flex;flex-wrap:wrap;gap:8px;padding:10px 14px}",
    ".mediab .mi{width:72px;height:72px;border-radius:8px;background:#f3f4f6;display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden;font-size:22px}",
    ".mediab .mi img{width:100%;height:100%;object-fit:cover}",
    ".mediab .mi.add{border:1.5px dashed #d1d5db;background:#fff;cursor:pointer;color:#6b7280}",
    ".mediab .mi .cv{position:absolute;top:4px;left:4px;font-size:9px;background:var(--accent);color:#fff;border-radius:4px;padding:1px 5px}",
    ".mediab .mi .ml{position:absolute;bottom:0;left:0;right:0;font-size:10px;background:rgba(0,0,0,.55);color:#fff;padding:2px 4px;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".mediab .ca{display:flex;gap:8px;padding:10px 14px;border-top:1px solid #f0f1f3}",
    ".mediab .ca button{flex:1;border-radius:8px;padding:8px 0;font-size:13px;cursor:pointer;font-weight:600;border:1.5px solid var(--accent)}",
    ".mediab .ca button.primary{background:var(--accent);color:#fff}",
    ".mediab .ca button.secondary{background:#fff;color:var(--accent)}",
    ".bars{background:#fff;border:1px solid #e5e7eb;border-radius:12px;margin:6px 0;max-width:92%;overflow:hidden;padding-bottom:6px}",
    ".bars .br{display:grid;grid-template-columns:1fr 2fr auto;gap:8px;align-items:center;padding:4px 14px;font-size:12px}",
    ".bars .bb{height:8px;background:#f3f4f6;border-radius:999px;overflow:hidden}",
    ".bars .bb i{display:block;height:100%;background:#9ca3af}",
    ".bars .br.acc .bb i{background:var(--accent)}",
    ".bars .bv{font-variant-numeric:tabular-nums;font-weight:500}",
    ".list .li.ghost{color:#6b7280;border-style:dashed}",
  ].join("\n");

  // 12345 -> "12.3k" — compact token counts for the usage footer
  function fmtTokens(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
    return String(n);
  }

  // Progress messages shown under the typing indicator while the agent works.
  // A ticker advances one phase every 5 seconds, so a long tool lookup feels
  // alive ("Checking records…") instead of frozen.
  var WAIT_PHASES = [
    "Thinking…",
    "Checking records…",
    "Filling in details…",
    "Still on it — bigger lookup than usual…"
  ];

  /**
   * The widget itself — one instance per page, created via AgentChat.init().
   * The constructor only stores configuration and calls _mount() to build the
   * UI; no network request happens until the user actually sends a message.
   * @param {Object} opts
   * @param {string} [opts.gateway]  gateway base URL; defaults to the origin
   *                                 this script was served from
   * @param {string} [opts.key]      shared gateway key, sent as X-Agent-Key
   * @param {string|Element} [opts.inline] render full-size inside this
   *                                 container instead of as a floating bubble
   * @param {Function} [opts.onSession] callback fired with the session id
   *                                 whenever the active session changes
   * @param {Function} [opts.onPreview] host-managed preview (#preview): called
   *                                 with each live draft state
   *                                 {tool, state, slots, missing}, and with
   *                                 null when the chat resets/switches. When
   *                                 set, the widget renders NO internal pane —
   *                                 the host page owns the preview UI (e.g. a
   *                                 side column next to the chat).
   * @param {string|Function} [opts.token] user Bearer token (#13/#login) —
   *                                 a string, or a function returning the
   *                                 current token (called per request, so a
   *                                 fresh login applies immediately); sent as
   *                                 `Authorization: Bearer` on every call
   * @param {string} [opts.title]    panel header text
   * @param {string} [opts.accent]   brand colour (CSS colour string)
   * @param {string} [opts.greeting] first bot message shown locally
   * @param {Array}  [opts.starters] chips shown with the greeting
   * @param {boolean} [opts.header]   false hides the widget's own header bar — for an inline
   *                                 host page that has its own chrome (the playground)
   * @param {Function} [opts.onTurn]  called after every completed turn with
   *                                 {user, display, ms, domain, kind, tool_trace, usage,
   *                                 completion, reply, ui} — what a host's trace pane shows
   */
  function Widget(opts) {
    this.gateway = (opts.gateway || SCRIPT_ORIGIN || "").replace(/\/+$/, "");
    if (!this.gateway) throw new Error("AgentChat: gateway URL required");
    this.key = opts.key || ""; // gateway shared key (#20) — sent as X-Agent-Key when set
    this.inline = opts.inline || null; // selector/element — render full-size inside it, no bubble (#portal)
    this.onSession = opts.onSession || null; // callback(session_id) whenever the active session changes
    this.onPreview = opts.onPreview || null; // host-managed preview UI (#preview) — widget renders no pane when set
    this.token = opts.token || null; // user Bearer token: string, or function returning the current one (#login)
    this.title = opts.title || "Chat with us";
    this.accent = opts.accent || "#000000"; // placeholder brand: black primary, white secondary
    this.greeting = opts.greeting || "Hi 👋 What would you like to do? Just type it.";
    // Guided entry point: chips shown with the greeting — set these per vertical
    // (one per entry flow). Override with opts.starters, [] to hide.
    this.starters = opts.starters || [];
    this.header = opts.header !== false; // the panel's own title bar; a host page with its own chrome turns it off
    this.onTurn = opts.onTurn || null; // host trace hook: the finished turn's facts (#trace)
    // URL schemes a `link` block may open besides http(s) (your app's own scheme). The gateway filters too.
    this.linkSchemes = opts.linkSchemes || [];
    this.sessionId = null;
    this.busy = false;
    this.completed = false; // set once the job is done — chat ends, composer disabled
    this._live = []; // interactive blocks from the latest agent turn; disabled once the user answers
    // Persist the session id per gateway origin so an abandoned chat resumes (#resume).
    this._sidKey = "marg:sid:" + this.gateway;
    this._mount();
  }

  // --- session persistence (resume across reloads/abandon) ---
  // The session id is the only thing stored client-side; the transcript itself
  // lives on the server. localStorage survives reloads and tab closes, so on
  // the next visit _start() can fetch the old transcript and resume. All
  // access is wrapped in try/catch because localStorage throws in some
  // private-browsing modes — the widget then simply behaves as "no resume".
  Widget.prototype._loadSid = function () { try { return window.localStorage.getItem(this._sidKey); } catch (e) { return null; } };
  Widget.prototype._saveSid = function (id) {
    try { window.localStorage.setItem(this._sidKey, id); } catch (e) {}
    if (this.onSession) { try { this.onSession(id); } catch (e) {} }
  };
  Widget.prototype._clearSid = function () {
    try { window.localStorage.removeItem(this._sidKey); } catch (e) {}
    if (this.onSession) { try { this.onSession(null); } catch (e) {} }
  };

  /**
   * Builds the whole UI once, at construction time. Side effects: appends a
   * host element to the page (bubble mode), attaches a Shadow DOM root, and
   * injects the stylesheet. Nothing network-related happens here.
   */
  Widget.prototype._mount = function () {
    // Step 1: pick the host element. Inline mode renders inside a container
    // the host page provides; bubble mode appends its own <div> to <body>.
    var host;
    if (this.inline) {
      host = typeof this.inline === "string" ? document.querySelector(this.inline) : this.inline;
      if (!host) throw new Error("AgentChat: inline container not found: " + this.inline);
    } else {
      host = document.createElement("div");
      host.id = "marg-chat-root";
      document.body.appendChild(host);
    }
    // Step 2: attach the Shadow DOM — the isolation boundary. Everything the
    // widget renders from here on goes into `this.shadow`, not the page DOM,
    // so host-page CSS/JS can't accidentally restyle or break the chat.
    this.shadow = host.attachShadow({ mode: "open" });
    var style = document.createElement("style");
    style.textContent = CSS;
    this.shadow.appendChild(style);
    this.shadow.host.style.setProperty("--accent", this.accent);

    // Step 3: build the composer — the message list, the text box (Enter sends,
    // Shift+Enter makes a new line), the send button and the mic button.
    var self = this;
    this.msgs = h("div", { class: "msgs" });
    this.input = h("textarea", { rows: "1", placeholder: "Type here…" });
    this.input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); self._send(self.input.value); }
    });
    this.sendBtn = h("button", { text: "➤", onclick: function () { self._send(self.input.value); } });
    // Voice notes (#14): tap to record, tap again to stop -> transcript lands in
    // the composer for review. Hidden where mic capture isn't available.
    this.micBtn = h("button", { class: "mic", text: "🎤", title: "Record a voice note", onclick: function () { self._toggleMic(); } });
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && typeof MediaRecorder !== "undefined")) {
      this.micBtn.style.display = "none";
    }
    // Photos & video (#15): the paperclip opens the OS picker (the camera, on a
    // phone). Files upload one per request and are written onto the record —
    // during the chat they wait for the create; afterwards they attach straight
    // away, which is why this button stays live on a completed chat.
    this.fileInput = h("input", { type: "file", accept: "image/*,video/*,.pdf,.txt,.csv,.json,.doc,.docx,.xlsx", multiple: "multiple" });
    this.fileInput.style.display = "none";
    this.fileInput.addEventListener("change", function () {
      self._uploadFiles(self.fileInput.files);
      self.fileInput.value = ""; // let the same file be picked again after a failure
    });
    this.clipBtn = h("button", { class: "clip", text: "📎", title: "Attach files", onclick: function () { self.fileInput.click(); } });
    this.mediaBar = h("div", { class: "media" });

    // Step 4: assemble the panel — header (title + close button in bubble
    // mode), the message area, the composer row, and the token-usage footer.
    var headKids = [h("span", { text: this.title })];
    // Draft preview toggle (#preview): appears once preview data
    // exists; tapping it shows/hides the docked pane. Unused in onPreview
    // (host-managed) mode — the host page renders its own preview UI.
    this.pvBtn = h("button", { class: "pvbtn", text: "🏠", title: "Draft preview", onclick: function () { self._togglePreview(); } });
    if (!this.onPreview) headKids.push(this.pvBtn);
    if (!this.inline) headKids.push(h("button", { text: "✕", onclick: function () { self.toggle(false); } }));
    // The docked pane itself — hidden until the user opens it via the 🏠 button.
    this.previewBox = h("div", { class: "pv" });
    this.previewBox.style.display = "none";
    var kids = this.header ? [h("div", { class: "head" }, headKids)] : [];
    if (!this.header && !this.onPreview) kids.push(h("div", { class: "head mini" }, [this.pvBtn]));
    this.panel = h("div", { class: "panel" }, kids.concat([
      this.previewBox,
      this.msgs,
      this.mediaBar,
      h("div", { class: "foot" }, [this.input, this.clipBtn, this.micBtn, this.sendBtn]),
      this.fileInput,
      this.usageBar = h("div", { class: "usage" })
    ]));
    this.panel.style.setProperty("--accent", this.accent);
    this.shadow.appendChild(this.panel);

    // Step 5: bubble mode adds the floating 💬 launcher; inline mode opens
    // immediately and starts the conversation flow.
    if (this.inline) {
      // Inline mode: always open, fills the host container, no bubble.
      this.panel.classList.add("inline", "open");
      this._start();
    } else {
      this.bubble = h("button", { class: "bubble", text: "💬", "aria-label": "Open chat", onclick: function () { self.toggle(); } });
      this.bubble.style.setProperty("--accent", this.accent);
      this.shadow.appendChild(this.bubble);
    }
  };

  /**
   * Opens/closes the chat panel (bubble mode). Pass true/false to force a
   * state, or nothing to flip it. The first open triggers _start() so the
   * greeting (or a resumed transcript) appears.
   * @param {boolean} [open] desired state; omitted = toggle
   */
  Widget.prototype.toggle = function (open) {
    var isOpen = typeof open === "boolean" ? open : !this.panel.classList.contains("open");
    this.panel.classList.toggle("open", isOpen);
    if (isOpen && !this._started) this._start(); // once — the session itself is minted on first message (#defer)
    if (isOpen) this.input.focus();
  };

  // --- voice notes (#14) ---
  /**
   * Mic button handler: first tap starts recording, second tap stops it.
   * How the browser recording pipeline works here:
   *   1. getUserMedia({audio:true}) asks the user for mic permission and
   *      returns a live audio stream.
   *   2. MediaRecorder consumes that stream and periodically emits compressed
   *      audio chunks (ondataavailable) which we collect in an array.
   *   3. On stop we release the mic (stop all tracks) and stitch the chunks
   *      into a single Blob — that Blob is the "voice note" we upload.
   * Side effects: toggles the button's recording style, and on stop hands the
   * audio Blob to _sendVoice().
   */
  Widget.prototype._toggleMic = function () {
    if (this._rec) { this._rec.stop(); return; } // second tap stops; onstop transcribes
    var self = this;
    // Pick the first audio container/codec this browser can actually record
    // (Chrome/Firefox prefer webm+opus; Safari records mp4).
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      var mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].filter(function (t) {
        return MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t);
      })[0];
      var rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      var chunks = [];
      rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = function () {
        stream.getTracks().forEach(function (t) { t.stop(); });
        self._rec = null;
        self.micBtn.classList.remove("rec");
        self.micBtn.textContent = "🎤";
        self._sendVoice(new Blob(chunks, { type: rec.mimeType || "audio/webm" }));
      };
      self._rec = rec;
      self.micBtn.classList.add("rec");
      self.micBtn.textContent = "◼";
      rec.start();
    }).catch(function () {
      self._error("Couldn't access the microphone — check browser permissions, or just type your message.");
    });
  };

  // WhatsApp-style voice bubble: play/pause + progress + duration, playing the
  // user's own recording from a local object URL. The transcript is never
  // shown — it only feeds the agent server-side.
  /**
   * Builds the playable voice-note bubble for the transcript pane.
   * URL.createObjectURL(blob) turns the in-memory recording into a temporary
   * local URL (blob:...) an <audio> element can play — no server round-trip.
   * @param {Blob} blob the recorded audio
   * @returns {{el: Element, setDuration: Function}} the bubble element plus a
   *   setter used later, because webm recordings often don't know their own
   *   duration until the server measures it (see the note below).
   */
  Widget.prototype._voiceBubble = function (blob) {
    var url = URL.createObjectURL(blob);
    var audio = new Audio(url);
    var bubble = this._bubbleEl("user");
    var btn = h("button", { class: "play", text: "▶" });
    var fill = h("div", { class: "fill" });
    var time = h("span", { class: "time", text: "0:00" });
    var wrap = h("div", { class: "voice" }, [btn, h("div", { class: "track" }, [fill]), time]);
    bubble.appendChild(wrap);

    var fmt = function (s) { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ":" + ("0" + (s % 60)).slice(-2); };
    var dur = 0;
    audio.addEventListener("loadedmetadata", function () {
      if (isFinite(audio.duration) && audio.duration > 0) { dur = audio.duration; time.textContent = fmt(dur); }
    });
    btn.addEventListener("click", function () {
      if (audio.paused) { audio.play(); btn.textContent = "⏸"; }
      else { audio.pause(); btn.textContent = "▶"; }
    });
    audio.addEventListener("timeupdate", function () {
      if (dur) fill.style.width = Math.min(100, (audio.currentTime / dur) * 100) + "%";
      time.textContent = fmt(dur ? Math.max(0, dur - audio.currentTime) : audio.currentTime);
    });
    audio.addEventListener("ended", function () {
      btn.textContent = "▶";
      fill.style.width = "0%";
      audio.currentTime = 0;
      if (dur) time.textContent = fmt(dur);
    });
    return {
      el: bubble,
      // MediaRecorder webm blobs often report Infinity duration — Deepgram's
      // measured duration (via the transcript event) fills the label instead.
      setDuration: function (s) { if (!dur && isFinite(s) && s > 0) { dur = s; time.textContent = fmt(s); } }
    };
  };

  // Send the recorded note as the chat turn itself — transcription runs in the
  // background inside the turn; the user sees (and can replay) their own
  // audio, never the transcript.
  /**
   * Uploads the voice note as one chat turn. Data flow: we POST the raw audio
   * bytes to /api/chat/voice (session id in the X-Agent-Session header, body
   * is the Blob itself, Content-Type is the audio MIME type). The gateway
   * transcribes it server-side and then streams the normal SSE reply back —
   * a "transcript" event first (we only use its measured duration to label
   * the player), then the usual delta/tool/done events, all handled by the
   * shared _streamChat().
   * @param {Blob} blob the recorded audio note
   * @param {boolean} [isRetry] true when re-sending after session recovery,
   *   to avoid an infinite recover loop
   */
  Widget.prototype._sendVoice = function (blob, isRetry) {
    if (this.busy || this.completed) return;
    var self = this;
    if (!this.sessionId) { this._withSession(function () { self._sendVoice(blob, isRetry); }); return; }
    this._retire();
    var note = this._voiceBubble(blob);
    this.busy = true;
    this.sendBtn.disabled = true;
    this.micBtn.classList.add("busy");

    var typing = h("div", { class: "msg bot typing" }, [h("i"), h("i"), h("i")]);
    var status = h("div", { class: "status", text: "Listening to your note…" });
    this.msgs.appendChild(typing);
    this.msgs.appendChild(status);
    this._anchorTo(note.el); // scroll anchoring (#ux), same as text sends
    var phase = 0;
    var ticker = setInterval(function () {
      phase = Math.min(phase + 1, WAIT_PHASES.length - 1);
      status.textContent = WAIT_PHASES[phase];
    }, 5000);

    var cleanup = function () {
      clearInterval(ticker);
      typing.remove();
      status.remove();
      self.busy = false;
      self.sendBtn.disabled = false;
      self.micBtn.classList.remove("busy");
    };
    var recover = function () {
      cleanup();
      note.el.remove();
      return self._newSession().then(function () {
        self._bot("(Reconnected — our earlier chat was lost when the service restarted, so we're starting fresh.)");
        self._sendVoice(blob, true);
      });
    };

    var headers = this._headers(false);
    headers["Content-Type"] = blob.type || "application/octet-stream";
    headers["X-Agent-Session"] = this.sessionId;
    this._streamChat({
      isRetry: isRetry,
      typing: typing,
      status: status,
      cleanup: cleanup,
      recover: recover,
      fetchFn: function () { return fetch(self.gateway + "/api/chat/voice", { method: "POST", headers: headers, body: blob }); },
      // transcript text is deliberately NOT rendered — only the measured duration labels the player
      onTranscript: function (d) { note.setDuration(d.duration_s); }
    });
  };

  /**
   * Builds the HTTP headers every gateway request shares.
   * @param {boolean} json true when the body is JSON (adds Content-Type)
   * @returns {Object} headers, including X-Agent-Key when a key is configured
   */
  Widget.prototype._headers = function (json) {
    var h = {};
    if (json) h["Content-Type"] = "application/json";
    if (this.key) h["X-Agent-Key"] = this.key;
    // User auth (#13/#login): opts.token is a string, or a function returning
    // the current token (lets the host read fresh storage on every request).
    // The gateway re-binds it to the session each turn and forwards it to tools.
    var t = typeof this.token === "function" ? this.token() : this.token;
    if (t) h["Authorization"] = "Bearer " + t;
    return h;
  };

  /**
   * Creates a brand-new server-side session: POST /api/session returns
   * {session_id, nudge}. We remember the id (in memory + localStorage for
   * resume), keep the server's nudge configuration, and open the live
   * event stream for server-pushed nudges.
   * @returns {Promise<string>} the new session id
   */
  Widget.prototype._newSession = function () {
    var self = this;
    return fetch(this.gateway + "/api/session", { method: "POST", headers: this._headers(false) })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        self.sessionId = j.session_id;
        self._saveSid(j.session_id);
        self._nudgeCfg = j.nudge || { enabled: true, max: 3, interval_ms: 300000 };
        self._subscribeEvents();
        return j.session_id;
      });
  };

  // --- no-reply nudges (#nudge): live via the server SSE stream, with a local
  // timer fallback if the browser can't hold that stream ("both" delivery). ---
  /**
   * Opens a long-lived SSE (Server-Sent Events) connection to
   * GET /api/session/:id/events and listens for "nudge" events — the server's
   * gentle "still there?" follow-ups when the user goes quiet.
   * How the stream is read: fetch() gives us the response body as a
   * ReadableStream; we read raw bytes chunk by chunk, decode them to text,
   * and split on the blank line ("\n\n") that terminates each SSE frame. The
   * last partial frame stays in `buf` until its remainder arrives.
   * The AbortController lets _stopEvents() close the connection on purpose;
   * unintentional drops fall back to a local nudge timer.
   */
  Widget.prototype._subscribeEvents = function () {
    var self = this;
    if (!this._nudgeCfg || this._nudgeCfg.enabled === false) return;
    if (this.completed || !this.sessionId) return;
    if (typeof ReadableStream === "undefined" || !window.fetch || typeof AbortController === "undefined") {
      this._startClientNudge(); // no streaming — fall back to a client timer
      return;
    }
    this._evAbort = new AbortController();
    fetch(this.gateway + "/api/session/" + encodeURIComponent(this.sessionId) + "/events", { headers: this._headers(false), signal: this._evAbort.signal })
      .then(function (r) {
        if (!r.ok || !r.body) { self._startClientNudge(); return; }
        var reader = r.body.getReader(), dec = new TextDecoder(), buf = "";
        function pump() {
          return reader.read().then(function (res) {
            if (res.done) return;
            buf += dec.decode(res.value, { stream: true });
            var frames = buf.split("\n\n"); buf = frames.pop();
            for (var i = 0; i < frames.length; i++) {
              var ev = self._parseSse(frames[i]);
              if (ev && ev.event === "nudge" && ev.data) self._onNudge(ev.data.text);
            }
            return pump();
          });
        }
        return pump();
      })
      .catch(function () { if (!self.completed && !self._evAbort._intentional) self._startClientNudge(); });
  };

  /** Closes the nudge SSE stream (marking the abort as intentional so we
   *  don't fall back to the timer) and cancels any local nudge timer. */
  Widget.prototype._stopEvents = function () {
    if (this._evAbort) { this._evAbort._intentional = true; try { this._evAbort.abort(); } catch (e) {} this._evAbort = null; }
    if (this._nudgeTimer) { clearInterval(this._nudgeTimer); this._nudgeTimer = null; }
  };

  // A server-delivered nudge — the server already persisted it; just surface it.
  Widget.prototype._onNudge = function (text) {
    if (this.completed || this.busy || !text) return;
    this._bot(text);
  };

  // Local fallback: only used when the live SSE stream isn't available.
  Widget.prototype._startClientNudge = function () {
    var self = this, cfg = this._nudgeCfg || { max: 3, interval_ms: 300000 };
    if (cfg.enabled === false) return;
    if (this._nudgeTimer) clearInterval(this._nudgeTimer);
    var LINES = [
      "Still there? 👋 Whenever you're ready, just send the next detail and we'll get this listed.",
      "No rush — I've saved everything so far. Ping me anytime to finish up.",
      "I'll leave it here for now 🙂 Your progress is saved — reply whenever and we'll pick right back up."
    ];
    this._nudgeCount = 0;
    this._nudgeTimer = setInterval(function () {
      if (self.completed || self.busy) return;
      if (self._nudgeCount >= cfg.max) { clearInterval(self._nudgeTimer); self._nudgeTimer = null; return; }
      self._bot(LINES[Math.min(self._nudgeCount, LINES.length - 1)]);
      self._nudgeCount++;
    }, cfg.interval_ms);
  };

  /**
   * The conversation's entry point, run once when the chat first opens.
   * If localStorage holds a previous session id we ask the gateway for that
   * session's transcript (GET /api/session/:id/history) and replay it; if the
   * server no longer knows the session (expired/purged) we clear the stored
   * id and start fresh with the greeting.
   */
  Widget.prototype._start = function () {
    var self = this;
    this._started = true;
    var stored = this._loadSid();
    if (stored) {
      // Try to resume the abandoned chat before greeting fresh (#resume).
      fetch(this.gateway + "/api/session/" + encodeURIComponent(stored) + "/history", { headers: this._headers(false) })
        .then(function (r) { if (!r.ok) throw new Error("no session"); return r.json(); })
        .then(function (j) { self.sessionId = stored; self._saveSid(stored); self._replayHistory(j); })
        .catch(function () { self._clearSid(); self._fresh(); });
    } else {
      this._fresh();
    }
  };

  // A clean first-time start: warm greeting + starter chips. Session creation is
  // DEFERRED to the first message (#defer) — an opened-and-abandoned chat leaves
  // no server session behind.
  Widget.prototype._fresh = function () {
    this._bot(this.greeting);
    if (this.starters.length) this._renderUi([{ type: "chips", options: this.starters }]);
  };

  // Lazily mint the session for the first message, then re-dispatch it (#defer).
  /**
   * Ensures a session exists before a message goes out. Called by _send /
   * _sendVoice when there's no session yet: creates one, then calls `retry`
   * (a closure that re-runs the original send). `_creating` guards against
   * two rapid sends both minting sessions.
   * @param {Function} retry re-dispatches the message once the session exists
   */
  Widget.prototype._withSession = function (retry) {
    var self = this;
    if (this._creating) return;
    this._creating = true;
    this._newSession()
      .then(function () { self._creating = false; retry(); })
      .catch(function () {
        self._creating = false;
        self._error("Could not reach the agent. Is the gateway running?");
      });
  };

  // Replay a resumed transcript exactly where the user left off (#resume).
  /**
   * Rebuilds the chat pane from a server transcript. The payload `j` comes
   * from GET /api/session/:id/history: {entries:[{role,text,ui}], nudge,
   * completed, completion, usage}. Each entry is re-rendered through the same
   * bubble/ui code the live chat uses, so a resumed chat looks identical —
   * including the last unanswered question's chips staying tappable.
   * @param {Object} j the history response body
   */
  Widget.prototype._replayHistory = function (j) {
    var self = this;
    var entries = (j && j.entries) || [];
    // Nothing said yet — greet as fresh, but photos may still have been
    // attached before the first message, so restore the strip either way (#15).
    if (!entries.length) { this._fresh(); this._loadMedia(); return; }
    this._bot("Welcome back 👋 Your details are saved — let's continue.");
    entries.forEach(function (e) {
      if (e.role === "user") {
        self._retire(); // the user answered — retire whatever was pending
        self._bubbleEl("user").textContent = e.text;
      } else {
        if (e.text) self._bot(e.text);
        // Only a NEW interactive block supersedes the last one; text-only turns
        // (e.g. nudges) leave a still-pending question tappable.
        if (e.ui && e.ui.length) { self._retire(); self._renderUi(e.ui); }
      }
    });
    // …so only the final agent turn's chips stay live (unless the chat has ended).
    this._nudgeCfg = j.nudge || { enabled: true, max: 3, interval_ms: 300000 };
    if (j.completed && j.completion) this._enterCompleted(j.completion);
    else {
      this._subscribeEvents(); this._loadMedia(); // live nudges + the photos already uploaded (#15)
      // Draft state persisted with the session (#preview) — the preview pane
      // (host column / 🏠 toggle) is available on demand right after resume.
      if (j.preview) this._previewEvent(j.preview);
    }
    if (j.usage) this._updateUsage(j.usage);
  };

  /**
   * Appends an empty message bubble ("user", "bot", or "err" styling) to the
   * message list and auto-scrolls to the bottom.
   * @param {string} cls extra class controlling the bubble's look/side
   * @returns {Element} the empty bubble, ready for content
   */
  Widget.prototype._bubbleEl = function (cls) {
    var el = h("div", { class: "msg " + cls });
    this.msgs.appendChild(el);
    if (!this._anchored) this.msgs.scrollTop = this.msgs.scrollHeight;
    return el;
  };

  /**
   * Claude-style scroll anchoring (#ux): when the user sends a message, the
   * view glides it to the TOP of the message pane so the reply streams into
   * the empty space beneath — instead of everything being pinned to the
   * bottom. While anchored, the append-time scroll-to-bottom calls are
   * suppressed for the rest of the turn (long replies just grow downward and
   * the user reads from the anchor, exactly like Claude's chat).
   * @param {Element} el the just-sent user bubble (or voice note) to anchor
   */
  Widget.prototype._anchorTo = function (el) {
    var self = this;
    this._anchored = true;
    // Next frame: the bubble needs layout before its position is measurable.
    requestAnimationFrame(function () {
      // Claude's trick: pad the bottom so there's a viewport of scrollable
      // room below the just-sent message — without it the scroll clamps and
      // the bubble stays stuck near the bottom. The reply streams into this
      // space; the padding persists (like Claude) until the chat resets.
      self.msgs.style.paddingBottom = Math.max(0, self.msgs.clientHeight - 140) + "px";
      // Position relative to the scroll container's content (offsetTop can't
      // be trusted here — the container isn't the offsetParent).
      var top = el.getBoundingClientRect().top - self.msgs.getBoundingClientRect().top + self.msgs.scrollTop - 10;
      top = Math.max(0, top);
      if (typeof self.msgs.scrollTo === "function") self.msgs.scrollTo({ top: top, behavior: "smooth" });
      else self.msgs.scrollTop = top;
    });
  };

  // Token utilisation footer (#17): when caps are configured, the tightest
  // remaining limit (warns under 15% left).
  //
  // The running "This chat: 41.2k tokens" total is deliberately NOT shown — it
  // is an internal cost figure and means nothing to a user. The session total
  // still rides along in the payload (and /api/session/:id/usage) for ops, so
  // restoring the line is a one-line change if it ever earns its place.
  Widget.prototype._updateUsage = function (usage) {
    if (!usage || typeof usage.session_tokens !== "number") return;
    var bar = this.usageBar;
    bar.textContent = "";
    var caps = usage.caps || [];
    if (caps.length) {
      var tight = caps.reduce(function (a, c) {
        return (c.remaining_tokens / c.limit_tokens) < (a.remaining_tokens / a.limit_tokens) ? c : a;
      });
      var frac = tight.remaining_tokens / tight.limit_tokens;
      var label = (tight.scope === "session" ? "chat limit" : tight.scope + " limit") + ": " + fmtTokens(tight.remaining_tokens) + " left";
      bar.appendChild(h("span", { class: frac < 0.15 ? "warn" : "", text: label }));
    }
    // Nothing to say (no caps configured) ⇒ stay hidden rather than reserving
    // an empty strip under the composer.
    bar.classList.toggle("on", bar.childNodes.length > 0);
  };

  // Convenience wrappers: a formatted agent bubble, and a red error bubble.
  Widget.prototype._bot = function (text) { if (text) renderRichText(this._bubbleEl("bot"), text); };
  Widget.prototype._error = function (text) { this._bubbleEl("err").textContent = text; };

  // ---- Photos & video (#15) ---------------------------------------------
  // Mirrors the gateway's upload policy so an obviously-too-big file fails
  // instantly in the browser instead of after a long upload. The gateway
  // enforces the real limits (AGENT_MEDIA_MAX_*_MB) either way.
  var MEDIA_MAX = { image: 15 * 1024 * 1024, video: 128 * 1024 * 1024, file: 25 * 1024 * 1024 };

  /**
   * Handles a pick from the file dialog: one request per file, all in flight
   * together. Uploading is deliberately independent of the chat turn — a user
   * can send photos while the agent is still answering, and the composer never
   * locks. Session creation is deferred (#defer), so a photo sent before the
   * first message mints the session first.
   * @param {FileList} list files chosen in the picker
   */
  Widget.prototype._uploadFiles = function (list) {
    var self = this;
    var files = Array.prototype.slice.call(list || []);
    if (!files.length) return;
    if (!this.sessionId) {
      // A session is already being minted (e.g. the user sent a message at
      // the same moment) — _withSession drops concurrent callers, so wait for
      // that one to land instead of losing the files.
      if (this._creating) { setTimeout(function () { self._uploadFiles(files); }, 400); return; }
      this._withSession(function () { self._uploadFiles(files); });
      return;
    }
    files.forEach(function (f) { self._uploadOne(f); });
  };

  /**
   * Uploads ONE file to POST /api/media — the body is the file itself, the
   * type tells the gateway which endpoint it belongs on (images and
   * videos have separate ones), and the session travels in a header.
   * @param {File} file
   * @param {boolean} [isRetry] true when re-sent after session recovery
   */
  Widget.prototype._uploadOne = function (file, isRetry) {
    var self = this;
    var mime = String(file.type || "");
    var kind = mime.indexOf("video/") === 0 ? "video" : mime.indexOf("image/") === 0 ? "image" : "file";
    var thumb = this._mediaThumb(file, kind);
    if (file.size > MEDIA_MAX[kind]) { thumb.fail(kind === "image" ? "Photo over 15 MB" : kind === "video" ? "Video over 128 MB" : "File over 25 MB"); return; }

    var headers = this._headers(false);
    headers["Content-Type"] = file.type;
    headers["X-Agent-Session"] = this.sessionId;
    // Header values must be plain ASCII; the gateway decodes this back.
    headers["X-Agent-Filename"] = encodeURIComponent(file.name || "");
    this.clipBtn.classList.add("busy");
    this._uploads = (this._uploads || 0) + 1;
    var settle = function () {
      self._uploads--;
      if (self._uploads <= 0) { self._uploads = 0; self.clipBtn.classList.remove("busy"); }
    };
    fetch(this.gateway + "/api/media", { method: "POST", headers: headers, body: file })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, j: j }; });
      })
      .then(function (res) {
        // The gateway forgot this session (restart/expiry) — mint a new one and
        // retry once, exactly like a lost chat turn does.
        if (res.status === 410 && !isRetry) {
          thumb.remove();
          settle();
          return self._newSession().then(function () { self._uploadOne(file, true); });
        }
        settle();
        if (!res.ok) { thumb.fail((res.j && res.j.error) || "Upload failed"); return; }
        thumb.done(res.j && res.j.key); // the key arms the tile's ✕ (#media-delete)
        self._syncMediaNote(res.j);
      })
      .catch(function () { settle(); thumb.fail("Upload failed — check your connection"); });
  };

  /**
   * Adds a tile for one file to the strip above the composer and returns the
   * handles used to settle it. Photos show a real preview (a local object URL —
   * nothing is fetched back from the server); videos show a film tile.
   * @returns {{done:Function, fail:Function, remove:Function}}
   */
  Widget.prototype._mediaThumb = function (file, kind) {
    var el = h("div", { class: "thumb", title: file.name || "" });
    if (kind === "image" && window.URL && URL.createObjectURL) {
      var img = h("img", { alt: "" });
      img.src = URL.createObjectURL(file);
      img.onload = function () { try { URL.revokeObjectURL(img.src); } catch (e) {} };
      el.appendChild(img);
    } else {
      el.appendChild(document.createTextNode(kind === "video" ? "🎬" : kind === "file" ? "📄" : "🖼"));
    }
    var ov = h("div", { class: "ov", text: "…" });
    el.appendChild(ov);
    this.mediaBar.insertBefore(el, this.mediaNote || null); // the note always stays last
    this.mediaBar.classList.add("on");
    var self = this;
    return {
      done: function (key) {
        ov.remove();
        if (key) self._armThumbDelete(el, String(key)); // ✕ appears once the server holds it (#media-delete)
      },
      remove: function () { el.remove(); },
      fail: function (msg) {
        el.classList.add("err");
        ov.textContent = "!";
        el.setAttribute("title", (file.name || "File") + " — " + msg);
        self._error(msg + ". " + (file.name || "That file") + " was not added.");
      }
    };
  };

  /**
   * Adds the remove badge to a media tile (#media-delete). Tapping ✕ asks the
   * gateway to drop the file — from the pending set, or off the record itself
   * when the photo was added after the create. The tile only disappears once
   * the server confirms, so a failed delete never lies to the user.
   * @param {Element} el  the .thumb tile
   * @param {string} key  the server-side media key
   */
  Widget.prototype._armThumbDelete = function (el, key) {
    var self = this;
    var x = h("button", { class: "x", text: "✕", title: "Remove this file", onclick: function () {
      x.disabled = true;
      var headers = self._headers(false);
      headers["X-Agent-Session"] = self.sessionId;
      fetch(self.gateway + "/api/media?key=" + encodeURIComponent(key), { method: "DELETE", headers: headers })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          if (!res.ok) { x.disabled = false; self._error((res.j && res.j.error) || "Could not remove that file."); return; }
          el.remove();
          if (!self.mediaBar.querySelector(".thumb")) self.mediaBar.classList.remove("on");
          self._syncMediaNote(res.j);
        })
        .catch(function () { x.disabled = false; self._error("Could not remove that file — check your connection."); });
    } });
    el.appendChild(x);
  };

  /**
   * The one-line status under the tiles. Before the record exists the files
   * are held by the gateway ("ready"); once it exists they are on the record.
   * @param {Object} state {images, video, attached_to} from the media endpoints
   */
  Widget.prototype._syncMediaNote = function (state) {
    if (!state) return;
    var items = Array.isArray(state.items) ? state.items : [];
    if (!items.length) return;
    var n = items.length;
    var words = n + (n === 1 ? " file" : " files");
    if (!this.mediaNote) this.mediaNote = h("div", { class: "mnote" });
    var pending = items.some(function (i) { return !i.attached; });
    this.mediaNote.textContent = !state.attached_to
      ? words + " ready — attached when you confirm."
      : pending ? words + " — attaching…" : words + " attached ✓";
    this.mediaBar.appendChild(this.mediaNote);
    this.mediaBar.classList.add("on");
  };

  /**
   * Restores the media strip when a chat is resumed (#resume): the gateway
   * still holds the keys, so the tiles come back as generic placeholders (the
   * original files only ever existed in the previous browser session).
   */
  Widget.prototype._loadMedia = function () {
    if (!this.sessionId) return;
    var self = this;
    var headers = this._headers(false);
    headers["X-Agent-Session"] = this.sessionId;
    fetch(this.gateway + "/api/media", { headers: headers })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !Array.isArray(j.items) || !j.items.length) return;
        if (self.mediaBar.querySelector(".thumb")) { self._syncMediaNote(j); return; }
        j.items.forEach(function (i) {
          var t = h("div", { class: "thumb", title: i.filename || "" });
          var src = i.url ? String(i.url) : (j.file_base && i.key && i.kind === "image" ? String(j.file_base).replace(/\/+$/, "") + "/" + i.key : "");
          if (src && i.kind === "image") { var im = h("img", { alt: "" }); im.src = src; t.appendChild(im); }
          else t.appendChild(document.createTextNode(i.kind === "video" ? "🎬" : i.kind === "file" ? "📄" : "🖼"));
          if (i.key) self._armThumbDelete(t, String(i.key));
          self.mediaBar.appendChild(t);
        });
        self.mediaBar.classList.add("on");
        self._syncMediaNote(j);
      })
      .catch(function () {});
  };

  // Entity created — end the chat cleanly (#completion). Shows a done panel with
  // a "View" button (when a URL is configured) and a way to start
  // another, then disables the composer. Idempotent.
  Widget.prototype._enterCompleted = function (completion) {
    if (this.completed) return;
    this.completed = true;
    this._stopEvents(); // no more nudges once the chat is done
    this._retire();
    this._previewReset(); // draft pane's job is done — the ended card takes over
    var self = this;
    var panel = h("div", { class: "ended" });
    panel.appendChild(h("div", { class: "ended-t", text: "✅ " + ((completion && completion.label) || "Done") }));
    var row = h("div", { class: "chips" });
    if (completion && completion.entity_url) {
      var view = h("a", { class: "done", href: String(completion.entity_url), target: "_blank", rel: "noopener noreferrer", text: "View →" });
      view.style.textDecoration = "none";
      row.appendChild(view);
    }
    // The nudge to add photos only means something if the user can act on it
    // right here — this opens the same picker as the composer's paperclip, and
    // anything picked now attaches to the record immediately.
    row.appendChild(h("button", { class: "secondary-pill", text: "📎 Add files", onclick: function () { self.fileInput.click(); } }));
    row.appendChild(h("button", { class: "secondary-pill", text: "Start another", onclick: function () { self._listAnother(); } }));
    panel.appendChild(row);
    this.msgs.appendChild(panel);
    this.msgs.scrollTop = this.msgs.scrollHeight;
    // Freeze the composer — this conversation is over.
    this.input.disabled = true;
    this.sendBtn.disabled = true;
    this.micBtn.disabled = true;
    this.clipBtn.disabled = false; // photos/video stay welcome after submitting (#15)
    this.input.placeholder = "This chat is complete — tap “Start another” to begin a new one.";
    // Refresh the strip's status line: photos held during the chat are written
    // onto the record right after the create, so re-check once shortly after.
    this._loadMedia();
    setTimeout(function () { self._loadMedia(); }, 3000);
  };

  // Clear the transcript pane and re-enable the composer (shared by newChat/openSession).
  Widget.prototype._reset = function () {
    this._stopEvents();
    this._previewReset(); // clear the draft pane / notify the host (#preview)
    this._anchored = false; // fresh chat scrolls normally until the first send
    this.msgs.style.paddingBottom = ""; // drop the anchor spacer (#ux)
    this.sessionId = null;
    this.completed = false;
    this._live = [];
    this.msgs.textContent = "";
    this.mediaBar.textContent = "";
    this.mediaBar.classList.remove("on");
    this.mediaNote = null;
    this.clipBtn.disabled = false;
    this.usageBar.textContent = "";
    this.usageBar.classList.remove("on");
    this.input.disabled = false;
    this.sendBtn.disabled = false;
    this.micBtn.disabled = false;
    this.input.placeholder = "Type here…";
  };

  // Start a brand-new chat — after one completed, or on demand from a host page.
  Widget.prototype.newChat = function () {
    this._reset();
    this._clearSid();
    this._fresh();
    this.input.focus();
  };
  Widget.prototype._listAnother = function () { this.newChat(); };

  // Switch to an existing session (host-page chat lists). Resumes its transcript;
  // completed chats replay read-only via the normal completion path.
  Widget.prototype.openSession = function (id) {
    if (!id || id === this.sessionId) return;
    this._reset();
    this._saveSid(id);
    this._start();
  };

  Widget.prototype._retire = function () {
    // an answered question's chips/cards must not stay tappable (double-create guard)
    this._live.forEach(function (el) { el.classList.add("used"); });
    this._live = [];
  };

  /**
   * Routes one `preview` SSE event (#preview): {tool, state, slots, missing}.
   * Host-managed mode (opts.onPreview set): the payload is handed to the host
   * page — e.g. demo.html's side column — and the widget renders nothing.
   * Self-managed mode: the docked pane content updates and the 🏠 header
   * button appears; the pane itself only shows when the user taps it, so
   * the chat view is never disturbed uninvited.
   * @param {Object} data the preview event payload
   */
  Widget.prototype._previewEvent = function (data) {
    if (!data || !data.slots || typeof data.slots !== "object") return;
    if (this.onPreview) {
      try { this.onPreview(data); } catch (e) {}
      return;
    }
    this._updatePreview(data);
  };

  /**
   * Updates the widget's own docked pane from one preview payload. Every
   * label/value is inserted as text (never HTML); field and missing counts
   * are capped. States: gathering (slots still missing) -> validated (ready
   * to submit) -> created. A failed tool call emits nothing, so the last
   * good state stays.
   * @param {Object} data the preview event payload
   */
  Widget.prototype._updatePreview = function (data) {
    var self = this;
    if (!this._pvBuilt) {
      this._pvBuilt = true;
      this._pvTitle = h("span", { text: "Draft" });
      this._pvState = h("span", { class: "st" });
      this._pvBody = h("div", { class: "pv-b" });
      this.previewBox.appendChild(h("div", {
        class: "pv-h",
        onclick: function () { self.previewBox.classList.toggle("open"); }
      }, [h("span", { text: "📝" }), this._pvTitle, h("span", { class: "car", text: "▾" }), this._pvState]));
      this.previewBox.appendChild(this._pvBody);
    }
    var slots = data.slots || {};
    var defaults = Array.isArray(data.defaults) ? data.defaults : [];
    var keys = Object.keys(slots).filter(function (k) { return k !== "confirmed" && k.indexOf("hide_") !== 0; }).slice(0, 40);
    this._pvTitle.textContent = "Draft · " + keys.length + (keys.length === 1 ? " field" : " fields");
    var missing = Array.isArray(data.missing) ? data.missing : [];
    this._pvState.textContent =
      data.state === "created" ? "✓ created"
      : data.state === "validated" ? "ready"
      : missing.length ? missing.length + " to go" : "in progress";
    this._pvState.className = "st" + (data.state === "created" || data.state === "validated" ? " ok" : "");
    this._pvBody.textContent = "";
    if (data.state !== "created") {
      this._pvBody.appendChild(h("div", { class: "pv-note", text: "🔒 Draft — only you can see this until you confirm." }));
    }
    keys.forEach(function (k) {
      var label = k.replace(/_/g, " ").replace(/^\w/, function (c) { return c.toUpperCase(); });
      var v = String(slots[k]);
      self._pvBody.appendChild(h("div", { class: "pv-f" }, [
        h("span", { class: "k", text: label }),
        h("span", { class: "v", text: v + (defaults.indexOf(k) >= 0 ? " (default)" : "") })
      ]));
    });
    if (missing.length) {
      this._pvBody.appendChild(h("div", { class: "pv-m", text: "Still needed: " + missing.slice(0, 6).map(String).join("; ") }));
    }
    this.pvBtn.classList.add("on");
  };

  /** 🏠 header button: show/hide the docked preview pane (opens expanded). */
  Widget.prototype._togglePreview = function () {
    this._pvOpen = !this._pvOpen;
    this.previewBox.style.display = this._pvOpen ? "" : "none";
    this.previewBox.classList.toggle("open", this._pvOpen);
  };

  /** Clear all preview UI/state (new chat, session switch, completion). */
  Widget.prototype._previewReset = function () {
    this._pvOpen = false;
    this.previewBox.style.display = "none";
    this.previewBox.classList.remove("open");
    if (this._pvBody) this._pvBody.textContent = "";
    this.pvBtn.classList.remove("on");
    if (this.onPreview) { try { this.onPreview(null); } catch (e) {} } // host clears its panel too
  };

  /**
   * Renders the agent's structured "ui" blocks — the tap-to-answer layer.
   * The gateway sends these alongside the reply text in the `done` event.
   * Block types and what tapping them does (every tap just calls _send() with
   * the option's value, i.e. it "types" the answer for the user):
   *   - chips:      one-tap answer buttons
   *   - multichips: multi-select chips + a Done button (min picks enforced);
   *                 Done sends all picks joined as one comma-separated message
   *   - card:       titled key/value summary (e.g. the confirmation card),
   *                 optionally with action buttons
   *   - toggles:    hide/show switches + Done  — ON means "hide this
   *                 field from the public record"
   *   - link:       an external URL button (e.g. "add photos" deep link)
   *   - list:       tappable rows with title/subtitle (e.g. pick a project)
   * Interactive blocks are pushed into this._live so _retire() can grey them
   * out once answered. All labels/values are inserted as text (never HTML),
   * and option counts are capped — the model can't inject markup or spam.
   * @param {Array} blocks the ui block array from the gateway (may be empty)
   */
  /* formEcho:start — pure (no DOM); mirrors packages/core/src/forms.ts formEcho so tests can pin the wording */
  function formEcho(block, vals) {
    var parts = [];
    var rows = Array.isArray(block.rows) ? block.rows : [];
    function labelOf(r, v) {
      var o = (r.options || []).filter(function (x) { return x && (x.value === v || x.label === v); })[0];
      return o ? String(o.label) : v;
    }
    function fill(tpl, r, v) {
      return String(tpl).replace(/\{([a-z0-9_]+)\}/gi, function (_m, k) {
        if (k === "v") return labelOf(r, v);
        var other = rows.filter(function (x) { return x.key === k; })[0];
        if (!other) return "";
        var ov = vals[k] !== undefined ? vals[k] : (other.value || "");
        return labelOf(other, String(ov));
      });
    }
    rows.forEach(function (r) {
      var v = String(vals[r.key] === undefined ? "" : vals[r.key]).trim();
      if (!v) return;
      if (r.say === "") return;
      if (typeof r.say === "string") { parts.push(fill(r.say, r, v)); return; }
      if (r.say && typeof r.say === "object") {
        var n = Number(v);
        var tpl = n === 0 && r.say.zero ? r.say.zero : n === 1 && r.say.one ? r.say.one : (r.say.many || "{v}");
        parts.push(fill(tpl, r, v));
        return;
      }
      parts.push(String(r.label || r.key) + ": " + labelOf(r, v));
    });
    var body = parts.filter(Boolean).join(" · ");
    return block.echo ? String(block.echo) + ": " + body : body;
  }
  /* formEcho:end */

  /**
   * Draws the ui blocks of one assistant turn. Every label/value is inserted as TEXT (never
   * HTML). Blocks the model may send: chips, multichips, list, card, toggles, link. Blocks the
   * runtime draws: form, table, progress, media, bars. Interactive blocks are retired (greyed)
   * once the user answers; a tap sends the option's value as the user's message.
   */
  Widget.prototype._renderUi = function (blocks) {
    var self = this;
    var okLink = function (url) {
      try {
        var p = new URL(String(url)).protocol;
        return p === "http:" || p === "https:" || self.linkSchemes.indexOf(p) >= 0 || self.linkSchemes.indexOf(p.replace(/:$/, "")) >= 0;
      } catch (e) { return false; }
    };
    (blocks || []).forEach(function (b) {
      if (!b || typeof b !== "object") return;

      if (b.type === "chips" && Array.isArray(b.options)) {
        var chips = h("div", { class: "chips" });
        var limit = Math.max(1, Math.min(24, (b.limit | 0) || 10));
        b.options.slice(0, limit).forEach(function (o) {
          var value = String(o.value != null ? o.value : (o.label || ""));
          var cls = "chip" + (o.ghost ? " ghost" : "") + (o.sel ? " sel" : "") + (o.disabled ? " off" : "");
          var chip = h("button", { class: cls, text: String(o.label || value), onclick: function () { if (!o.disabled) self._send(value); } });
          if (o.disabled) { chip.disabled = true; if (o.reason) chip.title = String(o.reason); }
          chips.appendChild(chip);
        });
        self.msgs.appendChild(chips);
        self._live.push(chips);

      } else if (b.type === "multichips" && Array.isArray(b.options)) {
        var min = Math.max(0, (b.min | 0) || 0);
        var max = (b.max | 0) || 0;
        var submitLabel = String(b.submit || "Done");
        var wrap = h("div", { class: "chips multi" });
        var picked = [];
        var done = h("button", { class: "done", text: submitLabel });
        var counter = h("span", { class: "cnt" });
        var refresh = function () {
          done.disabled = picked.length < min;
          done.textContent = submitLabel + (picked.length ? " (" + picked.length + ")" : "");
          counter.textContent = min > 1 ? picked.length + " / " + min + " min" : "";
        };
        var addChip = function (label, value, on, own) {
          var chip = h("button", { class: "chip" + (on ? " sel" : "") + (own ? " own" : ""), text: label });
          if (on) picked.push(value);
          chip.addEventListener("click", function () {
            var i = picked.indexOf(value);
            if (i >= 0) { picked.splice(i, 1); chip.classList.remove("sel"); }
            else { if (max && picked.length >= max) return; picked.push(value); chip.classList.add("sel"); }
            refresh();
          });
          return chip;
        };
        var page = (b.page | 0) || 0;
        var shown = 0, hidden = [];
        b.options.slice(0, 40).forEach(function (o) {
          var value = String(o.value != null ? o.value : (o.label || ""));
          var chip = addChip(String(o.label || value), value, Boolean(o.sel), Boolean(o.own));
          if (o.sug) chip.appendChild(h("span", { class: "sug", text: " ✦" }));
          if (page && !o.sel && shown >= page) { hidden.push(chip); chip.style.display = "none"; } else shown++;
          wrap.appendChild(chip);
        });
        if (hidden.length) {
          var more = h("button", { class: "chip ghost", text: "More (+" + hidden.length + ")", onclick: function () { hidden.forEach(function (c) { c.style.display = ""; }); more.remove(); } });
          wrap.appendChild(more);
        }
        if (b.own && typeof b.own === "object") {
          var ownMax = Math.max(1, (b.own.max | 0) || 30);
          var ownRow = h("div", { class: "own" });
          var ownIn = h("input", { type: "text", placeholder: String(b.own.placeholder || "Add your own"), maxlength: String(ownMax) });
          var addOwn = function () {
            var v = ownIn.value.trim().slice(0, ownMax);
            if (!v || picked.indexOf(v) >= 0) { ownIn.value = ""; return; }
            wrap.insertBefore(addChip(v, v, true, true), ownRow);
            ownIn.value = "";
            refresh();
          };
          ownIn.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); addOwn(); } });
          ownRow.appendChild(ownIn);
          ownRow.appendChild(h("button", { class: "chip", text: "Add", onclick: addOwn }));
          wrap.appendChild(ownRow);
        }
        done.addEventListener("click", function () { if (picked.length >= min) self._send(picked.join(", ")); });
        var foot = h("div", { class: "mfoot" }, [counter]);
        if (b.skip && b.skip.value) foot.appendChild(h("button", { class: "chip ghost", text: String(b.skip.label || "Skip"), onclick: function () { self._send(String(b.skip.value)); } }));
        foot.appendChild(done);
        wrap.appendChild(foot);
        refresh();
        self.msgs.appendChild(wrap);
        self._live.push(wrap);

      } else if (b.type === "card") {
        var card = h("div", { class: "card" + (b.compact ? " compact" : "") });
        if (b.title) card.appendChild(h("div", { class: "ct", text: String(b.title) }));
        (b.fields || []).slice(0, 40).forEach(function (f) {
          var v = h("span", { class: "v", text: String(f.value == null ? "" : f.value) });
          if (f.source && f.source !== "user") v.appendChild(h("span", { class: "src " + String(f.source), text: String(f.source) }));
          card.appendChild(h("div", { class: "cf" }, [h("span", { class: "k", text: String(f.label || "") }), v]));
        });
        if (Array.isArray(b.sections) && b.sections.length) {
          var secs = h("div", { class: "secs" });
          b.sections.slice(0, 12).forEach(function (sct) {
            secs.appendChild(h("button", { class: "chip mini", text: "✎ " + String(sct.label || sct.key), onclick: function () { self._send(String(sct.value || ("Edit " + sct.label))); } }));
          });
          card.appendChild(secs);
        }
        if (Array.isArray(b.actions) && b.actions.length) {
          var acts = h("div", { class: "ca" });
          b.actions.slice(0, 3).forEach(function (a, i) {
            acts.appendChild(h("button", { class: i === 0 ? "primary" : "secondary", text: String(a.label || ""), onclick: function () { self._send(String(a.value || a.label)); } }));
          });
          card.appendChild(acts);
          self._live.push(card);
        }
        self.msgs.appendChild(card);

      } else if (b.type === "toggles" && Array.isArray(b.options)) {
        var wrapT = h("div", { class: "toggles" });
        var tstate = {};
        var wire = b.wire && typeof b.wire === "object" ? b.wire : { prefix: "Hide: ", none: "Keep everything visible" };
        b.options.slice(0, 12).forEach(function (o) {
          var value = String(o.value || o.label || "");
          tstate[value] = Boolean(o.on);
          var sw = h("button", { class: "tg" + (o.on ? " on" : ""), type: "button", "aria-label": value }, [h("i")]);
          sw.addEventListener("click", function () { tstate[value] = !tstate[value]; sw.classList.toggle("on", tstate[value]); });
          wrapT.appendChild(h("div", { class: "tg-row" }, [h("span", { class: "tg-l", text: String(o.label || value) }), sw]));
        });
        var doneT = h("button", { class: "done", text: String(b.submit || "Done") });
        doneT.addEventListener("click", function () {
          var on = Object.keys(tstate).filter(function (k) { return tstate[k]; });
          self._send(on.length ? String(wire.prefix || "") + on.join(", ") : String(wire.none || "None"));
        });
        wrapT.appendChild(h("div", { class: "tg-row" }, [h("span", { class: "hint", text: String(b.hint || "") }), doneT]));
        self.msgs.appendChild(wrapT);
        self._live.push(wrapT);

      } else if (b.type === "link" && b.url) {
        if (!okLink(b.url)) return; // never a javascript: or unknown-scheme link
        var wrapL = h("div", { class: "chips" });
        var a = h("a", { class: "done", href: String(b.url), target: "_blank", rel: "noopener noreferrer", text: String(b.label || "Open") });
        a.style.textDecoration = "none";
        wrapL.appendChild(a);
        self.msgs.appendChild(wrapL);

      } else if (b.type === "form" && Array.isArray(b.rows)) {
        // A form card: rows the user fills in place — picks as chips, multi-picks, text / number
        // inputs — and ONE submit that sends every filled row as "Label [key]: value; …"
        // (packages/core/src/forms.ts parses it; the model never sees a form).
        var form = h("div", { class: "form" });
        if (b.title) form.appendChild(h("div", { class: "ct", text: String(b.title) }));
        var fvals = {};
        var rowSet = {};
        var frows = b.rows.slice(0, 24).filter(function (r) { return r && typeof r === "object" && r.key; });
        var fsubmit = String(b.submit || "Done");
        var fdone = h("button", { class: "primary", text: fsubmit });
        var frefresh = function () {
          var missing = frows.filter(function (r) { return r.required && !String(fvals[r.key] || "").trim(); }).length;
          fdone.disabled = missing > 0;
          fdone.textContent = fsubmit + (missing ? " (" + missing + " to fill)" : "");
        };
        frows.forEach(function (r) {
          var key = String(r.key), kind = String(r.kind || "text");
          if (r.value != null && String(r.value) !== "") fvals[key] = String(r.value);
          var head = h("div", { class: "fh" }, [h("span", { class: "fl", text: String(r.label || key) + (r.required ? " *" : "") })]);
          if (r.source) head.appendChild(h("span", { class: "src " + String(r.source), text: String(r.source) }));
          var row = h("div", { class: "fr" }, [head]);
          var errEl = null;
          if (r.error) { errEl = h("div", { class: "ferr", text: String(r.error) }); row.classList.add("bad"); }
          var errOk = function () {
            if (errEl && String(fvals[key] || "").trim()) { row.classList.remove("bad"); if (errEl.parentNode) errEl.parentNode.removeChild(errEl); errEl = null; }
          };
          if ((kind === "pick" || kind === "multi") && Array.isArray(r.options) && r.options.length) {
            var opts = h("div", { class: "chips fo" });
            var pickedF = kind === "multi" ? String(fvals[key] || "").split(/,\s*/).filter(Boolean) : [];
            var chipVals = [];
            r.options.slice(0, 24).forEach(function (o) {
              var value = String(o.value != null ? o.value : (o.label || ""));
              var on = kind === "pick" ? fvals[key] === value : pickedF.indexOf(value) >= 0;
              var chip = h("button", { class: "chip" + (on ? " sel" : ""), text: String(o.label || value) });
              chipVals.push({ el: chip, value: value });
              chip.addEventListener("click", function () {
                if (kind === "pick") {
                  fvals[key] = fvals[key] === value ? "" : value;
                  Array.prototype.forEach.call(opts.children, function (c) { c.classList.toggle("sel", c === chip && !!fvals[key]); });
                  if (fvals[key] === value && o.fills && typeof o.fills === "object") {
                    Object.keys(o.fills).forEach(function (k) { if (k !== key && Object.prototype.hasOwnProperty.call(rowSet, k)) rowSet[k](o.fills[k]); });
                  }
                } else {
                  var i = pickedF.indexOf(value);
                  if (i >= 0) { pickedF.splice(i, 1); chip.classList.remove("sel"); } else { pickedF.push(value); chip.classList.add("sel"); }
                  fvals[key] = pickedF.join(", ");
                }
                errOk();
                frefresh();
              });
              opts.appendChild(chip);
            });
            row.appendChild(opts);
            rowSet[key] = function (v) {
              var want = String(v == null ? "" : v);
              if (kind === "pick") {
                if (want && !chipVals.some(function (c) { return c.value === want; })) return;
                fvals[key] = want;
                chipVals.forEach(function (c) { c.el.classList.toggle("sel", !!want && c.value === want); });
              } else {
                var wanted = want.split(/,\s*/).filter(Boolean);
                pickedF.length = 0;
                chipVals.forEach(function (c) { var on2 = wanted.indexOf(c.value) >= 0; c.el.classList.toggle("sel", on2); if (on2) pickedF.push(c.value); });
                fvals[key] = pickedF.join(", ");
              }
              errOk();
              frefresh();
            };
          } else {
            var numeric = kind === "num" || kind === "area";
            // a date row is a native date input: the value is already YYYY-MM-DD, which forms.ts validates
            var input = kind === "date"
              ? h("input", { class: "fi", type: "date" })
              : h("input", { class: "fi", type: "text", inputmode: kind === "num" ? "decimal" : "text", placeholder: r.unit ? "in " + String(r.unit) : (r.placeholder ? String(r.placeholder) : "") });
            if (fvals[key]) input.value = fvals[key];
            var inSync = function () {
              var v = input.value.trim();
              fvals[key] = v && numeric && r.unit && /^[\d.,]+$/.test(v) ? v + " " + r.unit : v;
            };
            input.addEventListener("input", function () { inSync(); errOk(); frefresh(); });
            rowSet[key] = function (v) { input.value = String(v == null ? "" : v); inSync(); errOk(); frefresh(); };
            row.appendChild(input);
          }
          if (r.hint) row.appendChild(h("div", { class: "hint", text: String(r.hint) }));
          if (errEl) row.appendChild(errEl);
          form.appendChild(row);
        });
        var fa = h("div", { class: "ca" });
        if (b.skip && b.skip.value) fa.appendChild(h("button", { class: "secondary", text: String(b.skip.label || "Skip"), onclick: function () { self._send(String(b.skip.value)); } }));
        fdone.addEventListener("click", function () {
          var parts = [];
          frows.forEach(function (r) { var v = String(fvals[r.key] || "").trim(); if (v) parts.push(String(r.label || r.key) + " [" + r.key + "]: " + v.replace(/;/g, ",")); });
          if (parts.length) self._send(parts.join("; "), false, formEcho(b, fvals));
        });
        fa.appendChild(fdone);
        form.appendChild(fa);
        frefresh();
        self.msgs.appendChild(form);
        self._live.push(form);

      } else if (b.type === "table" && Array.isArray(b.columns) && Array.isArray(b.rows)) {
        var cols = b.columns.slice(0, 6).map(function (c) { return String(c == null ? "" : c); });
        var tbl = h("div", { class: cols.length >= 6 ? "tbl dense" : "tbl" });
        if (b.title) tbl.appendChild(h("div", { class: "tt", text: String(b.title) }));
        var thead = h("thead", {}, [h("tr", {}, cols.map(function (c) { return h("th", { text: c }); }))]);
        var tbody = h("tbody");
        b.rows.slice(0, 10).forEach(function (row) {
          if (!Array.isArray(row)) return;
          tbody.appendChild(h("tr", {}, cols.map(function (_, i) {
            var cell = String(row[i] == null ? "" : row[i]);
            return h("td", { class: /^[₹$€£]|^—$|^[+−-]?\d[\d,.]*\*?%?$/.test(cell) ? "num" : "", text: cell });
          })));
        });
        tbl.appendChild(h("div", { class: "ts" }, [h("table", {}, [thead, tbody])]));
        if (b.note) tbl.appendChild(h("div", { class: "bn", text: String(b.note) }));
        self.msgs.appendChild(tbl);

      } else if (b.type === "progress") {
        var pg = h("div", { class: "prog" });
        var status = String(b.status || "running");
        pg.appendChild(h("div", { class: "pt" }, [h("span", { text: String(b.title || "Working…") }), h("span", { class: "st " + status, text: status === "ready" ? "Ready" : status === "failed" ? "Failed" : "In progress" })]));
        var pct = Math.max(0, Math.min(100, Number(b.pct) || 0));
        var fill = h("i"); fill.style.width = (status === "ready" ? 100 : pct) + "%";
        pg.appendChild(h("div", { class: "bar" }, [fill]));
        var stages = Array.isArray(b.stages) ? b.stages.map(String) : [];
        var cur = Math.max(0, Math.min(stages.length - 1, Number(b.stage) || 0));
        if (stages.length) pg.appendChild(h("div", { class: "stg", text: (status === "running" ? "⏳ " : "") + stages[cur] }));
        if (b.note) pg.appendChild(h("div", { class: "bn", text: String(b.note) }));
        self.msgs.appendChild(pg);

      } else if (b.type === "media") {
        var mb = h("div", { class: "mediab" });
        var mitems = (Array.isArray(b.items) ? b.items : []).slice(0, 30).filter(function (it) { return it && typeof it === "object"; });
        var head2 = h("div", { class: "ct" }, [h("span", { text: String(b.title || "Files") })]);
        head2.appendChild(h("span", { class: "cnt", text: mitems.length + " added" + (b.min_recommended && mitems.length < b.min_recommended ? " · " + b.min_recommended + "+ recommended" : "") }));
        mb.appendChild(head2);
        var grid = h("div", { class: "grid" });
        mitems.forEach(function (it, i) {
          var tile = h("div", { class: "mi" });
          if (it.url) tile.appendChild(h("img", { src: String(it.url), alt: "" })); else tile.appendChild(document.createTextNode("🖼"));
          if (it.cover || i === 0) tile.appendChild(h("span", { class: "cv", text: "COVER" }));
          if (it.label) tile.appendChild(h("span", { class: "ml", text: String(it.label) }));
          grid.appendChild(tile);
        });
        grid.appendChild(h("div", { class: "mi add", text: "+", title: "Add files", onclick: function () { self.fileInput.click(); } }));
        mb.appendChild(grid);
        if (b.note) mb.appendChild(h("div", { class: "bn", text: String(b.note) }));
        if (Array.isArray(b.actions) && b.actions.length) {
          var ma = h("div", { class: "ca" });
          b.actions.slice(0, 3).forEach(function (a2, i) {
            ma.appendChild(h("button", { class: i === 0 ? "primary" : "secondary", text: String(a2.label || ""), onclick: function () { self._send(String(a2.value || a2.label)); } }));
          });
          mb.appendChild(ma);
          self._live.push(mb);
        }
        self.msgs.appendChild(mb);

      } else if (b.type === "bars" && Array.isArray(b.items)) {
        var bars = h("div", { class: "bars" });
        if (b.title) bars.appendChild(h("div", { class: "tt", text: String(b.title) }));
        var maxAmt = Math.max.apply(null, b.items.map(function (it) { return Number(it.amount) || 0; }).concat([1]));
        b.items.slice(0, 8).forEach(function (it) {
          var w = Math.max(2, Math.round((Number(it.amount) || 0) / maxAmt * 100));
          var f = h("i"); f.style.width = w + "%";
          bars.appendChild(h("div", { class: "br" + (it.accent ? " acc" : "") }, [h("span", { class: "bl", text: String(it.label || "") + (it.sub ? " · " + String(it.sub) : "") }), h("div", { class: "bb" }, [f]), h("span", { class: "bv", text: String(it.value || "") })]));
        });
        if (b.note) bars.appendChild(h("div", { class: "bn", text: String(b.note) }));
        self.msgs.appendChild(bars);

      } else if (b.type === "list" && Array.isArray(b.items)) {
        var list = h("div", { class: "list" });
        b.items.slice(0, 20).forEach(function (it) {
          var li = h("div", { class: it.ghost ? "li ghost" : "li", onclick: function () { self._send(String(it.value || it.title)); } }, [h("div", { class: "t", text: String(it.title || "") })]);
          if (it.subtitle) li.appendChild(h("div", { class: "s", text: String(it.subtitle) }));
          list.appendChild(li);
        });
        self.msgs.appendChild(list);
        self._live.push(list);
      }
    });
    if (!this._anchored) this.msgs.scrollTop = this.msgs.scrollHeight;
  };

  /**
   * Sends one text turn — the heart of the widget. Called when the user
   * hits Enter, taps the send button, or taps any chip/card/list option.
   * Steps: guard against double-sends -> make sure a session exists -> show
   * the user's bubble + typing indicator -> hand off to the streaming
   * (_streamChat) or JSON (_jsonChat) transport.
   * @param {string} text the user's message (or a tapped option's value)
   * @param {boolean} [isRetry] true when re-sending after session recovery
   */
  Widget.prototype._send = function (text, isRetry, display) {
    // Refuse empty input, overlapping sends (busy), or a finished chat.
    text = (text || "").trim();
    if (!text || this.busy || this.completed) return;
    var self = this;
    // No session yet? Create one first, then this exact call is re-run.
    if (!this.sessionId) { this._withSession(function () { self._send(text, isRetry); }); return; }
    if (this._nudgeTimer) this._startClientNudge(); // user active — restart the fallback nudge window
    // Grey out the previous turn's chips (answered), echo the user's text
    // as a user bubble, and lock the composer while the agent works.
    this._retire();
    var userEl = this._bubbleEl("user");
    userEl.textContent = display || text;
    this.input.value = "";
    this.busy = true;
    this.sendBtn.disabled = true;

    // Typing dots + a status line that advances through WAIT_PHASES every 5s
    // so long agent turns (tool lookups) still feel responsive.
    var typing = h("div", { class: "msg bot typing" }, [h("i"), h("i"), h("i")]);
    var status = h("div", { class: "status", text: WAIT_PHASES[0] });
    this.msgs.appendChild(typing);
    this.msgs.appendChild(status);
    this._anchorTo(userEl); // scroll anchoring (#ux): question glides to the top, reply streams below
    var phase = 0;
    var ticker = setInterval(function () {
      phase = Math.min(phase + 1, WAIT_PHASES.length - 1);
      status.textContent = WAIT_PHASES[phase];
    }, 5000);

    // Shared teardown: remove the indicators and unlock the composer. Runs on
    // success AND on every error path.
    var cleanup = function () {
      clearInterval(ticker);
      typing.remove();
      status.remove();
      self.busy = false;
      self.sendBtn.disabled = false;
      self.input.focus();
    };

    // Gateway restarted and lost this session — start fresh and replay once.
    var recover = function () {
      cleanup();
      var lastMsg = self.msgs.querySelector(".msg.user:last-of-type");
      if (lastMsg) lastMsg.remove();
      return self._newSession().then(function () {
        self._bot("(Reconnected — our earlier chat was lost when the service restarted, so we're starting fresh.)");
        self._send(text, true, display);
      });
    };

    // Bundle everything a transport needs into one context object, then pick
    // the transport: streaming SSE when the browser supports ReadableStream,
    // otherwise the plain JSON request/response fallback.
    var ctx = { text: text, display: display, isRetry: isRetry, typing: typing, status: status, cleanup: cleanup, recover: recover, t0: Date.now() };
    if (typeof ReadableStream !== "undefined" && window.fetch) this._streamChat(ctx);
    else this._jsonChat(ctx);
  };

  // Streaming path (#21): consume SSE deltas into a live bubble; ui blocks and
  // the clean final reply arrive in the `done` event. Voice turns (#14) pass
  // ctx.fetchFn (audio POST) + ctx.onTranscript; text turns use the default.
  /**
   * The streaming transport. We POST the turn to /api/chat/stream (or, for
   * voice, run ctx.fetchFn which POSTs audio to /api/chat/voice) and read the
   * response as a stream of Server-Sent Events (SSE):
   *   - "transcript": (voice only) STT result — passed to ctx.onTranscript
   *   - "delta":      the next slice of reply text — appended to `acc` and the
   *                   whole accumulated text is re-rendered into a live bot
   *                   bubble, so the reply appears to type itself out
   *   - "tool":       the agent is calling a tool — bump the status line
   *   - "done":       the finished turn: clean reply text, ui blocks, usage
   *                   figures, and (after a create) the completion object
   *   - "error":      a turn-level failure delivered inside the stream
   * Stream mechanics: response.body.getReader() yields raw byte chunks;
   * TextDecoder turns them into text; frames are separated by a blank line
   * ("\n\n"), and a half-received frame waits in `buf` for its next chunk.
   * `pump()` is a small recursive loop — read a chunk, process its frames,
   * read again — until the server closes the stream.
   * @param {Object} ctx built by _send/_sendVoice: {text?, isRetry, typing,
   *   status, cleanup, recover, fetchFn?, onTranscript?}
   */
  Widget.prototype._streamChat = function (ctx) {
    var self = this, botEl = null, acc = "", finished = false;
    var reqP = ctx.fetchFn ? ctx.fetchFn() : fetch(this.gateway + "/api/chat/stream", {
      method: "POST",
      headers: this._headers(true),
      body: JSON.stringify({ session_id: this.sessionId, message: ctx.text, display: ctx.display || undefined })
    });
    reqP
      .then(function (r) {
        if (!r.ok || !r.body) {
          // non-SSE error response (e.g. 400/unknown session) — read JSON and route through the shared handler
          return r.json().catch(function () { return {}; }).then(function (j) {
            if (/unknown session/i.test((j && j.error) || "") && !ctx.isRetry) return ctx.recover();
            if (r.status === 501) self.micBtn.style.display = "none"; // gateway has no STT configured
            ctx.cleanup();
            if (j && j.completed) return self._enterCompleted(null); // 409: chat already complete
            self._error((j && j.error) || "Something went wrong.");
          });
        }
        var reader = r.body.getReader(), dec = new TextDecoder(), buf = "";
        function pump() {
          return reader.read().then(function (res) {
            if (res.done) { if (!finished) ctx.cleanup(); return; }
            buf += dec.decode(res.value, { stream: true });
            var frames = buf.split("\n\n"); buf = frames.pop();
            for (var i = 0; i < frames.length; i++) {
              var ev = self._parseSse(frames[i]); if (!ev) continue;
              if (ev.event === "transcript") {
                if (ctx.onTranscript) ctx.onTranscript(ev.data);
              } else if (ev.event === "delta") {
                if (!botEl) { ctx.typing.remove(); botEl = self._bubbleEl("bot"); }
                acc += ev.data.text || "";
                botEl.textContent = ""; renderRichText(botEl, acc);
                if (!self._anchored) self.msgs.scrollTop = self.msgs.scrollHeight;
              } else if (ev.event === "tool") {
                ctx.status.textContent = WAIT_PHASES[Math.min(1, WAIT_PHASES.length - 1)];
              } else if (ev.event === "preview") {
                self._previewEvent(ev.data); // live draft state (#preview)
              } else if (ev.event === "done") {
                finished = true; ctx.cleanup();
                if (!botEl && ev.data.reply) self._bot(ev.data.reply);
                else if (botEl) { botEl.textContent = ""; renderRichText(botEl, ev.data.reply || acc); }
                self._renderUi(ev.data.ui);
                self._updateUsage(ev.data.usage);
                self._turnDone(ctx, ev.data);
                if (ev.data.completion) self._enterCompleted(ev.data.completion); // entity created → end chat
              } else if (ev.event === "error") {
                finished = true;
                if (/unknown session/i.test((ev.data && ev.data.error) || "") && !ctx.isRetry) return ctx.recover();
                ctx.cleanup(); self._error((ev.data && ev.data.error) || "Something went wrong.");
              }
            }
            return pump();
          });
        }
        return pump();
      })
      .catch(function () { if (!finished) { ctx.cleanup(); self._error("Connection lost — try again."); } });
  };

  /**
   * Parses one raw SSE frame into {event, data}. A frame is a few lines like
   * "event: delta" and "data: {json...}"; we pull the event name, join the
   * data lines, and JSON-parse them. Returns null for keep-alives or
   * malformed frames so callers can simply skip them.
   * @param {string} frame one frame's text (without the trailing blank line)
   * @returns {{event: string, data: Object}|null}
   */
  Widget.prototype._parseSse = function (frame) {
    var event = "message", data = "";
    frame.split("\n").forEach(function (line) {
      if (line.indexOf("event:") === 0) event = line.slice(6).trim();
      else if (line.indexOf("data:") === 0) data += line.slice(5).trim();
    });
    if (!data) return null;
    try { return { event: event, data: JSON.parse(data) }; } catch (e) { return null; }
  };

  /**
   * The finished turn's facts for the host (#trace): the user's text, the elapsed time, which
   * domain answered, whether the runtime or the model did (kind), every tool call with its
   * time, usage and the completion. The host's errors never break the chat.
   */
  Widget.prototype._turnDone = function (ctx, data) {
    if (!this.onTurn || !data) return;
    try {
      this.onTurn({ user: ctx.text, display: ctx.display || null, ms: Date.now() - (ctx.t0 || Date.now()), domain: data.domain || null, kind: data.kind || null, tool_trace: data.tool_trace || [], usage: data.usage || null, completion: data.completion || null, reply: data.reply || "", ui: data.ui || [] });
    } catch (e) {}
  };

  // Non-streaming fallback (older browsers / no ReadableStream).
  /**
   * POSTs the turn to /api/chat and waits for the complete JSON response
   * {reply, ui, usage, completion} — same data as the stream's `done` event,
   * just without the word-by-word effect. Handles the same recovery and
   * completion paths as the streaming transport.
   * @param {Object} ctx same shape as in _streamChat (text turns only)
   */
  Widget.prototype._jsonChat = function (ctx) {
    var self = this;
    fetch(this.gateway + "/api/chat", {
      method: "POST",
      headers: this._headers(true),
      body: JSON.stringify({ session_id: this.sessionId, message: ctx.text, display: ctx.display || undefined })
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok && /unknown session/i.test(res.j.error || "") && !ctx.isRetry) return ctx.recover();
        ctx.cleanup();
        if (!res.ok) {
          if (res.j && res.j.completed) return self._enterCompleted(null); // already complete on the server
          return self._error(res.j.error || "Something went wrong.");
        }
        self._bot(res.j.reply);
        self._renderUi(res.j.ui);
        self._updateUsage(res.j.usage);
        self._turnDone(ctx, res.j);
        if (res.j.completion) self._enterCompleted(res.j.completion);
      })
      .catch(function () { ctx.cleanup(); self._error("Connection lost — try again."); });
  };

  // The public SDK surface — the ONLY global this file creates. Host pages
  // call AgentChat.init(opts) once (a singleton: repeat calls return the same
  // widget), then optionally open() / newChat() / openSession(id).
  window.AgentChat = {
    _instance: null,
    init: function (opts) {
      if (this._instance) return this._instance;
      this._instance = new Widget(opts || {});
      return this._instance;
    },
    open: function () { if (this._instance) this._instance.toggle(true); },
    newChat: function () { if (this._instance) this._instance.newChat(); },
    openSession: function (id) { if (this._instance) this._instance.openSession(id); }
  };

  // <script src=".../widget.js" data-agent-auto data-gateway="..." data-title="..." data-accent="...">
  // Auto-boot: the zero-code embed path. If the <script> tag carries
  // data-agent-auto, we read the other data-* attributes as options and call
  // init() ourselves — waiting for DOMContentLoaded if the page's DOM (the
  // document structure) isn't ready yet, since _mount() appends to <body>.
  var cur = document.currentScript;
  if (cur && cur.hasAttribute("data-agent-auto")) {
    var boot = function () {
      window.AgentChat.init({
        gateway: cur.getAttribute("data-gateway") || SCRIPT_ORIGIN,
        key: cur.getAttribute("data-key") || undefined,
        title: cur.getAttribute("data-title") || undefined,
        accent: cur.getAttribute("data-accent") || undefined
      });
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
    else boot();
  }
})();
