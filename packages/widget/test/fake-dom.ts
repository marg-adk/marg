/**
 * fake-dom.ts — a small fake DOM: exactly the part of the browser the chat widget (packages/widget/widget.js) uses, so the widget's own code can run under
 * Node in a test (widget.test.ts). Not a general DOM: elements, text nodes, a shadow root, classList, attributes, a compound-selector engine (tag, .class, #id,
 * [attr], [attr="v"], :not(simple), :last-of-type, descendant and child combinators, comma groups), events that bubble, `on<type>` handlers, and the few element
 * properties the widget reads and writes (value, disabled, src, textContent, scrollTop …). Anything the widget calls that is missing here throws — which is how
 * a gap shows up.
 */

type Listener = (ev: any) => void;

export class FakeText {
  parent: FakeEl | null = null;
  constructor(public data: string) {}
  get textContent(): string { return this.data; }
  remove(): void { this.parent?.removeChild(this as any); }
}

/** One simple selector: tag?, classes, id, attribute tests, :not(...) tests. */
interface Simple { tag?: string; classes: string[]; id?: string; attrs: { name: string; value?: string }[]; nots: Simple[]; lastOfType?: boolean }

function parseSimple(src: string): Simple {
  const out: Simple = { classes: [], attrs: [], nots: [] };
  let i = 0;
  const ident = (): string => { const m = /^[\w-]+/.exec(src.slice(i)); if (!m) throw new Error(`fake-dom: cannot parse selector "${src}" at ${i}`); i += m[0].length; return m[0]; };
  if (/^[a-zA-Z*]/.test(src)) { const t = ident(); if (t !== "*") out.tag = t.toLowerCase(); }
  while (i < src.length) {
    const c = src[i];
    if (c === ".") { i++; out.classes.push(ident()); }
    else if (c === "#") { i++; out.id = ident(); }
    else if (c === "[") {
      const end = src.indexOf("]", i);
      const body = src.slice(i + 1, end);
      const m = /^([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?$/.exec(body);
      if (!m) throw new Error(`fake-dom: cannot parse attribute selector [${body}]`);
      out.attrs.push({ name: m[1], value: m[2] ?? m[3] ?? m[4] });
      i = end + 1;
    } else if (src.startsWith(":last-of-type", i)) {
      out.lastOfType = true;
      i += ":last-of-type".length;
    } else if (src.startsWith(":not(", i)) {
      let depth = 1, j = i + 5;
      while (j < src.length && depth) { if (src[j] === "(") depth++; else if (src[j] === ")") depth--; j++; }
      out.nots.push(parseSimple(src.slice(i + 5, j - 1)));
      i = j;
    } else throw new Error(`fake-dom: unsupported selector part "${src.slice(i)}" in "${src}"`);
  }
  return out;
}

/** A selector group as [simple, combinator-to-the-previous] pairs ("" = descendant, ">" = child). */
function parseGroup(src: string): { s: Simple; comb: "" | ">" }[] {
  const parts: { s: Simple; comb: "" | ">" }[] = [];
  const tokens = src.trim().replace(/\s*>\s*/g, " > ").split(/\s+/).filter(Boolean);
  let comb: "" | ">" = "";
  for (const t of tokens) {
    if (t === ">") { comb = ">"; continue; }
    parts.push({ s: parseSimple(t), comb });
    comb = "";
  }
  return parts;
}

function matchesSimple(el: FakeEl, s: Simple): boolean {
  if (s.tag && el.tag !== s.tag) return false;
  if (s.id && el.getAttribute("id") !== s.id) return false;
  for (const c of s.classes) if (!el.classList.contains(c)) return false;
  for (const a of s.attrs) {
    const v = el.getAttribute(a.name);
    if (v === null) return false;
    if (a.value !== undefined && v !== a.value) return false;
  }
  for (const n of s.nots) if (matchesSimple(el, n)) return false;
  if (s.lastOfType) {
    // the last element among its siblings with the same tag (the widget's session recovery asks for `.msg.user:last-of-type`)
    const same = (el.parent?.children ?? []).filter((c) => c instanceof FakeEl && c.tag === el.tag);
    if (same[same.length - 1] !== el) return false;
  }
  return true;
}

function matchesGroup(el: FakeEl, group: { s: Simple; comb: "" | ">" }[]): boolean {
  let idx = group.length - 1;
  if (!matchesSimple(el, group[idx].s)) return false;
  let cur: FakeEl | null = el;
  while (idx > 0) {
    const comb = group[idx].comb;
    const want = group[idx - 1].s;
    let p: FakeEl | null = cur!.parent;
    if (comb === ">") { if (!p || !matchesSimple(p, want)) return false; cur = p; idx--; continue; }
    while (p && !matchesSimple(p, want)) p = p.parent;
    if (!p) return false;
    cur = p; idx--;
  }
  return true;
}

export class FakeEl {
  attrs = new Map<string, string>();
  children: (FakeEl | FakeText)[] = [];
  parent: FakeEl | null = null;
  listeners = new Map<string, Listener[]>();
  // properties the widget sets directly
  disabled = false;
  value = "";
  src = "";
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  files: any = null;
  title = "";
  accept = "";
  type = "";
  hidden = false;
  style: any;
  shadowRoot: FakeEl | null = null;
  host: FakeEl | null = null;
  [k: string]: any;

  constructor(public tag: string, public doc?: FakeDocument) {
    const store: Record<string, string> = {};
    this.style = new Proxy(store, { get: (t, k: string) => (k === "setProperty" ? (n: string, v: string) => { t[n] = v; } : k === "removeProperty" ? (n: string) => { delete t[n]; } : (t[k] ?? "")), set: (t, k: string, v: string) => { t[k] = v; return true; } });
  }

  get classList() {
    const self = this;
    const list = (): string[] => (self.attrs.get("class") ?? "").split(/\s+/).filter(Boolean);
    const set = (l: string[]): void => { self.attrs.set("class", l.join(" ")); };
    return {
      add: (...c: string[]) => { const l = list(); for (const x of c) if (!l.includes(x)) l.push(x); set(l); },
      remove: (...c: string[]) => set(list().filter((x) => !c.includes(x))),
      contains: (c: string) => list().includes(c),
      toggle: (c: string, force?: boolean) => { const has = list().includes(c); const want = force === undefined ? !has : force; if (want && !has) set([...list(), c]); if (!want && has) set(list().filter((x) => x !== c)); return want; },
    };
  }
  get className(): string { return this.attrs.get("class") ?? ""; }
  set className(v: string) { this.attrs.set("class", v); }
  get firstChild(): FakeEl | FakeText | null { return this.children[0] ?? null; }
  get lastChild(): FakeEl | FakeText | null { return this.children[this.children.length - 1] ?? null; }
  get childNodes(): (FakeEl | FakeText)[] { return this.children; }
  get nextSibling(): FakeEl | FakeText | null { if (!this.parent) return null; const i = this.parent.children.indexOf(this); return this.parent.children[i + 1] ?? null; }
  get parentNode(): FakeEl | null { return this.parent; }
  get textContent(): string { return this.children.map((c) => c.textContent).join(""); }
  set textContent(v: string) { for (const c of this.children) c.parent = null; this.children = v === "" ? [] : [Object.assign(new FakeText(String(v)), { parent: this })]; }
  get innerHTML(): string { return this.textContent; }
  set innerHTML(v: string) { this.textContent = String(v).replace(/<[^>]+>/g, ""); }
  get id(): string { return this.attrs.get("id") ?? ""; }
  set id(v: string) { this.attrs.set("id", v); }

  setAttribute(k: string, v: string): void { this.attrs.set(k, String(v)); if (k === "value") this.value = String(v); }
  getAttribute(k: string): string | null { return this.attrs.has(k) ? this.attrs.get(k)! : null; }
  hasAttribute(k: string): boolean { return this.attrs.has(k); }
  removeAttribute(k: string): void { this.attrs.delete(k); }

  appendChild<T extends FakeEl | FakeText>(c: T): T { return this.insertBefore(c, null); }
  insertBefore<T extends FakeEl | FakeText>(c: T, ref: FakeEl | FakeText | null): T {
    if (c.parent) c.parent.removeChild(c as any);
    c.parent = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (ref && i < 0) throw new Error("fake-dom: insertBefore reference is not a child");
    if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
    return c;
  }
  removeChild(c: FakeEl | FakeText): void { const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); c.parent = null; } }
  remove(): void { this.parent?.removeChild(this); }
  contains(n: FakeEl | FakeText): boolean { for (let p: FakeEl | FakeText | null = n; p; p = (p as any).parent) if (p === this) return true; return false; }

  attachShadow(_o: { mode: string }): FakeEl { const r = new FakeEl("#shadow-root", this.doc); r.host = this; r.parent = null; this.shadowRoot = r; return r; }

  addEventListener(type: string, fn: Listener): void { const l = this.listeners.get(type) ?? []; l.push(fn); this.listeners.set(type, l); }
  removeEventListener(type: string, fn: Listener): void { this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn)); }
  /** Bubbles to the ancestors (unless stopped); the target's own `on<type>` property runs first, as in a browser. */
  dispatchEvent(ev: any): boolean {
    ev.target = ev.target ?? this;
    ev.preventDefault = ev.preventDefault ?? (() => { ev.defaultPrevented = true; });
    ev.stopPropagation = ev.stopPropagation ?? (() => { ev._stopped = true; });
    for (let n: FakeEl | null = this; n && !ev._stopped; n = n.parent ?? (n.host ?? null)) {
      ev.currentTarget = n;
      const prop = n["on" + ev.type];
      if (typeof prop === "function") prop.call(n, ev);
      for (const fn of [...(n.listeners.get(ev.type) ?? [])]) fn.call(n, ev);
      if (ev.bubbles === false) break;
    }
    return !ev.defaultPrevented;
  }
  /** What a user's tap does: nothing on a disabled control, else a bubbling click. */
  click(): void { if (this.disabled) return; this.dispatchEvent({ type: "click", bubbles: true }); }
  focus(): void {}
  blur(): void {}
  select(): void {}
  scrollIntoView(): void {}
  getBoundingClientRect() { return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }; }

  querySelectorAll(selector: string): FakeEl[] {
    const groups = selector.split(",").map(parseGroup);
    const out: FakeEl[] = [];
    const walk = (n: FakeEl): void => { for (const c of n.children) if (c instanceof FakeEl) { if (groups.some((g) => matchesGroup(c, g))) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelector(selector: string): FakeEl | null { return this.querySelectorAll(selector)[0] ?? null; }
}

export class FakeDocument {
  body = new FakeEl("body", this);
  readyState = "complete";
  currentScript: null = null;
  createElement(tag: string): FakeEl { return new FakeEl(String(tag).toLowerCase(), this); }
  createTextNode(data: string): FakeText { return new FakeText(String(data)); }
  /** A mount point for inline mode: an element with this id under the body. */
  mount(id: string): FakeEl { const el = this.createElement("div"); el.setAttribute("id", id); this.body.appendChild(el); return el; }
  querySelector(sel: string): FakeEl | null { return this.body.querySelector(sel); }
  querySelectorAll(sel: string): FakeEl[] { return this.body.querySelectorAll(sel); }
  addEventListener(): void {}
  removeEventListener(): void {}
}
