/**
 * widget-harness.ts — runs the REAL chat widget (packages/widget/widget.js) under Node, so its behaviour can be tested, not just grepped: the file is
 * evaluated in a `node:vm` context whose browser globals are the fake DOM (./fake-dom.ts), a controllable clock, a scripted `fetch` (a tiny model of the
 * gateway's endpoints) and counted `URL.createObjectURL` / `revokeObjectURL`. Nothing here talks to a network or a model.
 *
 *   const world = await makeWorld();                         // widget mounted inline in #chat, session minted
 *   world.draw({ type: "chips", options: [...] });           // what the runtime would send
 *   world.btn("Billing").click(); await world.settle();
 *   world.chat                                               // the messages the widget sent
 *
 * `makeWorld({ stream: true })` gives the widget a streaming browser (POST /api/chat/stream answered as SSE); without it the widget takes its JSON
 * fallback (POST /api/chat).
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { FakeDocument, FakeEl } from "./fake-dom.js";

const WIDGET_SRC = readFileSync(new URL("../widget.js", import.meta.url), "utf8");

export type Json = Record<string, any>;
export interface Req { method: string; path: string; query: URLSearchParams; headers: Record<string, string>; body: any }
/** `sse`: answer as the streaming endpoint does — these frames as one text/event-stream body. */
export type Reply = { status?: number; body?: unknown; sse?: { event: string; data: unknown }[] } | undefined;
/** A test's handler sits in front of the gateway model: it answers instead, holds the request, refuses it (reject), or passes (`return next()`). */
export type Handler = (req: Req, next: () => Reply | Promise<Reply>) => Reply | Promise<Reply>;

/** A controllable clock: the widget's setTimeout / setInterval / requestAnimationFrame run only when the test advances time. */
export class Clock {
  now = 0;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void; every?: number }>();
  setTimeout = (fn: () => void, ms = 0): number => { const id = ++this.seq; this.timers.set(id, { at: this.now + Math.max(0, Number(ms) || 0), fn }); return id; };
  setInterval = (fn: () => void, ms = 0): number => { const id = ++this.seq; const every = Math.max(1, Number(ms) || 1); this.timers.set(id, { at: this.now + every, fn, every }); return id; };
  clear = (id: number): void => { this.timers.delete(id); };
  raf = (fn: () => void): number => this.setTimeout(fn, 16);
  pending(): number { return this.timers.size; }
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      let next: { id: number; at: number } | null = null;
      for (const [id, t] of this.timers) if (t.at <= end && (!next || t.at < next.at || (t.at === next.at && id < next.id))) next = { id, at: t.at };
      if (!next) break;
      const t = this.timers.get(next.id)!;
      this.now = Math.max(this.now, t.at);
      if (t.every) t.at += t.every; else this.timers.delete(next.id);
      t.fn();
    }
    this.now = end;
  }
}

export interface FakeFile { name: string; type: string; size: number }
export const file = (name: string, type = "image/jpeg", size = 200_000): FakeFile => ({ name, type, size });

export class World {
  doc = new FakeDocument();
  clock = new Clock();
  /** Every fetch the widget made, in order. */
  calls: Req[] = [];
  /** What the gateway holds for the chat: the media state (the shape of GET /api/media). */
  media: { items: Json[]; attached_to?: string; max_items: number; file_base: string } = { items: [], max_items: 30, file_base: "https://files.test/f" };
  /** What GET /api/session/:id/history answers for a resumed chat. */
  history: Json = { entries: [], completed: false, nudge: { enabled: false }, usage: null };
  /** Every payload the page's preview hook was given (`previews: true`); null = the host was told to clear it. */
  previews: (Json | null)[] = [];
  /** The messages the widget sent, in order. */
  chat: string[] = [];
  /** The chat request bodies (message, display, session_id). */
  turns: Json[] = [];
  /** What the next chat turn answers: reply text, ui blocks, usage — and, on the streaming endpoint, an optional `preview` payload and `completion`. */
  chatReply: Json = { reply: "ok", ui: [], usage: null };
  handlers: Handler[] = [];
  blobs = { created: [] as string[], revoked: [] as string[] };
  store = new Map<string, string>();
  picks: string[] = [];
  sandbox: any;
  w: any;
  private nextKey = 1;

  snapshot(): Json {
    return JSON.parse(JSON.stringify({ file_base: this.media.file_base, items: this.media.items, attached_to: this.media.attached_to, max_items: this.media.max_items }));
  }
  /** Puts files straight into the world (what an earlier upload or a reload left on the gateway). */
  hold(...names: string[]): string[] { return names.map((n) => this.addUploaded(n, "image/jpeg")); }
  addUploaded(name: string, type = "image/jpeg"): string {
    const key = `key${this.nextKey++}`;
    const kind = String(type).startsWith("video/") ? "video" : String(type).startsWith("image/") ? "image" : "file";
    this.media.items.push({ key, kind, filename: name, cover: kind === "image" && !this.media.items.some((i) => i.kind === "image"), attached: Boolean(this.media.attached_to) });
    return key;
  }

  private respond(req: Req): Reply | Promise<Reply> {
    const run = (i: number): Reply | Promise<Reply> => (i < this.handlers.length ? this.handlers[i](req, () => run(i + 1)) : this.gateway(req));
    return run(0);
  }
  /** The model of the gateway: the endpoints the widget calls. */
  private gateway(req: Req): Reply {
    if (req.method === "POST" && req.path === "/api/session") return { body: { session_id: "sess-1", nudge: { enabled: false } } };
    if (req.method === "GET" && /^\/api\/session\/[^/]+\/history$/.test(req.path)) return { body: this.history };
    if (req.method === "GET" && /^\/api\/session\/[^/]+\/events$/.test(req.path)) return { sse: [] };
    if (req.method === "GET" && req.path === "/api/media") return { body: this.snapshot() };
    if (req.method === "POST" && req.path === "/api/media") {
      let name = req.headers["X-Agent-Filename"] ?? "";
      try { name = decodeURIComponent(name); } catch { /* keep */ }
      const key = this.addUploaded(name, req.headers["Content-Type"]);
      return { body: { uploaded: true, key, pending: !this.media.attached_to, ...this.snapshot() } };
    }
    if (req.method === "DELETE" && req.path === "/api/media") {
      const k = req.query.get("key") ?? "";
      this.media.items = this.media.items.filter((i) => i.key !== k);
      return { body: { deleted: true, ...this.snapshot() } };
    }
    if (req.method === "POST" && req.path === "/api/chat") {
      this.chat.push(String(req.body?.message ?? ""));
      this.turns.push(req.body ?? {});
      return { body: this.chatReply };
    }
    if (req.method === "POST" && req.path === "/api/chat/stream") {
      this.chat.push(String(req.body?.message ?? ""));
      this.turns.push(req.body ?? {});
      const r = this.chatReply;
      const frames: { event: string; data: unknown }[] = [];
      if (r.reply) frames.push({ event: "delta", data: { text: r.reply } });
      if (r.preview) frames.push({ event: "preview", data: r.preview });
      frames.push({ event: "done", data: { reply: r.reply ?? "", ui: r.ui ?? [], usage: r.usage ?? null, ...(r.completion ? { completion: r.completion } : {}), ...(r.domain ? { domain: r.domain } : {}), ...(r.kind ? { kind: r.kind } : {}), ...(r.tool_trace ? { tool_trace: r.tool_trace } : {}) } });
      return { sse: frames };
    }
    return { status: 404, body: { error: `no route ${req.method} ${req.path}` } };
  }

  /** The widget's `fetch`. A handler returning a promise holds the request; a rejected promise is a lost connection. */
  fetch = (url: string, init: Json = {}): Promise<Json> => {
    const u = new URL(String(url));
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init.headers ?? {})) headers[k] = String(v);
    let body: any = init.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { /* keep the text */ } }
    const req: Req = { method: String(init.method ?? "GET").toUpperCase(), path: u.pathname, query: u.searchParams, headers, body };
    this.calls.push(req);
    return Promise.resolve(this.respond(req)).then((r) => {
      const status = r?.status ?? 200;
      const payload = r?.body ?? {};
      const out: Json = { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(JSON.parse(JSON.stringify(payload))), text: () => Promise.resolve(JSON.stringify(payload)) };
      if (r?.sse) {
        const bytes = new TextEncoder().encode(r.sse.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join(""));
        out.body = { getReader: () => { let sent = false; return { read: () => Promise.resolve(sent ? { done: true } : (sent = true, { done: false, value: bytes })) }; } };
      }
      return out;
    });
  };

  // ---- the page ----
  get shadow(): FakeEl { return this.w.shadow; }
  q(sel: string): FakeEl | null { return this.shadow.querySelector(sel); }
  qa(sel: string): FakeEl[] { return this.shadow.querySelectorAll(sel); }
  /** A button by its text (exact, or the text it starts with: "Done (2 to fill)"). */
  btn(text: string, scope: FakeEl = this.shadow): FakeEl {
    const all = scope.querySelectorAll("button");
    const hit = all.find((b) => b.textContent === text) ?? all.find((b) => b.textContent.startsWith(text));
    if (!hit) throw new Error(`no button "${text}" (have: ${all.map((b) => JSON.stringify(b.textContent)).join(", ")})`);
    return hit;
  }
  /** Everything the user reads, one string per matching element. */
  texts(cls: string): string[] { return this.qa(cls).map((e) => e.textContent); }
  /** Types into an input/textarea the way a user does (the widget listens for `input`). */
  type(el: FakeEl, value: string): void { el.value = value; el.dispatchEvent({ type: "input", bubbles: true }); }
  /** What the file input does when the user picks files in the dialog. */
  pick(files: FakeFile[]): void { const fi = this.w.fileInput; fi.files = files; fi.dispatchEvent({ type: "change", bubbles: true }); }
  /** Draws blocks exactly as the `done` event would. */
  draw(...blocks: Json[]): void { this.w._renderUi(blocks); }
  /** The entity is created: the gateway marks the chat's files attached, and the widget gets the completion the `done` event carries. */
  async complete(completion: Json = { entity_id: "E-1", label: "Entry E-1" }): Promise<void> {
    this.media.attached_to = String(completion.entity_id);
    this.media.items.forEach((i) => { i.attached = true; });
    this.w._enterCompleted(completion);
    await this.settle();
  }
  /** Lets every pending promise run (the widget chains .then on fetches). */
  async settle(n = 4): Promise<void> { for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r)); }
  /** Moves the clock and lets the promises it unblocks run. */
  async advance(ms: number): Promise<void> { this.clock.advance(ms); await this.settle(); }
}

/** Mounts the widget in a fresh fake page. `session`: mint the session now (what the first message or the first picked file does). `store`: localStorage before the widget loads (a stored session id resumes). */
export async function makeWorld(opts: { session?: boolean; previews?: boolean; init?: Json; stream?: boolean; store?: Record<string, string> } = {}): Promise<World> {
  const world = new World();
  for (const [k, v] of Object.entries(opts.store ?? {})) world.store.set(k, v);
  const doc = world.doc;
  doc.mount("chat");
  const clock = world.clock;
  const sandbox: any = {
    document: doc,
    navigator: {},
    console,
    setTimeout: clock.setTimeout, clearTimeout: clock.clear, setInterval: clock.setInterval, clearInterval: clock.clear, requestAnimationFrame: clock.raf,
    fetch: world.fetch,
    TextEncoder, TextDecoder, AbortController,
    // `stream: true` — the browser can read an SSE body, so the widget takes its streaming transport; otherwise its JSON fallback
    ...(opts.stream ? { ReadableStream: function ReadableStream() {} } : {}),
    localStorage: { getItem: (k: string) => world.store.get(k) ?? null, setItem: (k: string, v: string) => { world.store.set(k, String(v)); }, removeItem: (k: string) => { world.store.delete(k); } },
    URL: Object.assign(function (u: string, b?: string) { return new URL(u, b); }, {
      createObjectURL: (f: unknown) => { const id = `blob:fake/${world.blobs.created.length + 1}`; world.blobs.created.push(id); void f; return id; },
      revokeObjectURL: (u: string) => { world.blobs.revoked.push(u); },
    }),
  };
  sandbox.window = sandbox;
  world.sandbox = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(WIDGET_SRC, sandbox, { filename: "widget.js" });
  world.w = sandbox.AgentChat.init({ gateway: "http://gw.test", inline: "#chat", ...(opts.previews ? { onPreview: (d: Json | null) => { world.previews.push(d === null ? null : JSON.parse(JSON.stringify(d))); } } : {}), ...(opts.init ?? {}) });
  // the file picker opens nothing here — it is recorded
  world.w.fileInput.click = () => { world.picks.push(String(world.w.fileInput.getAttribute("accept") ?? "")); };
  await world.settle();
  if (opts.session !== false && !world.w.sessionId) { await world.w._newSession(); await world.settle(); }
  return world;
}
