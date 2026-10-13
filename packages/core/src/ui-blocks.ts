/**
 * ui-blocks.ts — the ```ui block protocol on the runtime side.
 *
 * The model emits fenced JSON blocks inside prose; the runtime strips them from the stream
 * and delivers them structured in `done`. Everything here is pure and shared by the live
 * stream (visibleSoFar) and the finished reply (extractUiBlocks), so the user can never be
 * shown something mid-stream that the final reply then takes away.
 *
 * Tolerant of what models really emit around a block (measured on production traffic — about
 * 1 block in 40 was malformed): junk tokens glued to the closing fence, a last block closed with
 * two backticks or not closed at all, "```ui {json} ```" on one line, no fence at all (a line
 * that is nothing but a {"type":…} object). While streaming, an open block and a trailing partial
 * fence are held back, so fence fragments never flash in the bubble.
 *
 * Also here: the safety filter every block passes before a client sees it (`sanitizeUi`: link
 * scheme allowlist, lone chips, caps), reply dedupe (a model re-emitting its pre-tool text after
 * the tool answered), and the summary-card rows built from a draft.
 */
import type { CardRow, UiBlock } from "@marg-adk/types";
import { envList } from "./env.js";

const BARE_BLOCK = /^\{\s*"type"\s*:\s*"[a-z]+"/;

export function splitUi(text: string, final: boolean): { prose: string; blocks: string[] } {
  const blocks: string[] = [];
  let prose = "";
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("```ui", i);
    if (open === -1) {
      prose += text.slice(i);
      break;
    }
    prose += text.slice(i, open);
    const bodyStart = open + 5;
    const close = text.indexOf("```", bodyStart);
    if (close === -1) {
      if (final) blocks.push(text.slice(bodyStart).replace(/`+\s*$/, ""));
      break;
    }
    blocks.push(text.slice(bodyStart, close));
    const eol = text.indexOf("\n", close + 3);
    if (eol === -1) break;
    i = eol;
  }
  const lines = prose.split("\n");
  for (let n = 0; n < lines.length; n++) {
    const t = lines[n].trim();
    if (BARE_BLOCK.test(t) && t.endsWith("}")) {
      try {
        JSON.parse(t);
        blocks.push(t);
        lines[n] = "";
      } catch {
        /* not a complete block — leave the line */
      }
    }
  }
  prose = lines.join("\n");
  if (!final) {
    // hold back a trailing partial fence: "`", "``", "```u", "```ui"
    const m = /`{1,3}(?:u(?:i)?)?$/.exec(prose);
    if (m) prose = prose.slice(0, m.index);
  }
  return { prose: prose.replace(/\n{3,}/g, "\n\n").trim(), blocks };
}

/** The prose safe to show so far — complete blocks removed, an open block and fence fragments hidden. */
export function visibleSoFar(full: string): string {
  return splitUi(full, false).prose;
}

/** Pull the ```ui blocks out of a finished reply; malformed ones are dropped, never crash. */
export function extractUiBlocks(text: string): { clean: string; ui: unknown[] } {
  const { prose, blocks } = splitUi(text, true);
  const ui: unknown[] = [];
  for (const raw of blocks) {
    try {
      const parsed = JSON.parse(raw.trim());
      if (parsed && typeof parsed === "object" && typeof (parsed as { type?: unknown }).type === "string") ui.push(parsed);
    } catch {
      /* malformed block — leave it out */
    }
  }
  return { clean: prose, ui };
}

/** A model sometimes re-emits its pre-tool text after the tool answers: drop a sentence that already appeared. */
export function dedupeSentences(text: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const sentence of text.split(/(?<=[.!?])\s+|\n/)) {
    const key = sentence.trim().toLowerCase().replace(/\s+/g, " ");
    if (!key) {
      out.push(sentence);
      continue;
    }
    if (key.length > 12 && seen.has(key)) continue;
    seen.add(key);
    out.push(sentence);
  }
  return out.join(" ").replace(/\s{2,}/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

/** Two identical blocks in one reply (same JSON) collapse to one. */
export function dedupeBlocks(ui: unknown[]): unknown[] {
  const seen = new Set<string>();
  return ui.filter((b) => {
    const key = JSON.stringify(b);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const LINK_SCHEMES = new Set(["http:", "https:", ...envList("AGENT_LINK_SCHEMES").map((s) => (s.endsWith(":") ? s : s + ":"))]);
const MAX_BLOCKS = 4;

/** A URL a client may open: http/https and the app schemes in AGENT_LINK_SCHEMES. */
export function linkAllowed(url: unknown): boolean {
  if (typeof url !== "string") return false;
  try {
    return LINK_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * The safety pass every block takes before a client sees it: `link` blocks need an allowed
 * scheme (a model-emitted `javascript:` link is XSS in every host page), chips need at least two
 * options, option values are strings, and at most MAX_BLOCKS blocks survive.
 */
export function sanitizeUi(ui: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const b of ui) {
    if (!b || typeof b !== "object") continue;
    const block = b as Record<string, unknown>;
    const type = block.type;
    if (type === "link") {
      if (!linkAllowed(block.url) || typeof block.label !== "string") continue;
    }
    if (type === "chips" || type === "multichips" || type === "toggles") {
      const options = Array.isArray(block.options) ? block.options.filter((o) => o && typeof o === "object" && typeof (o as { label?: unknown }).label === "string") : [];
      if (type === "chips" && options.length < 2) continue;
      if (!options.length) continue;
      block.options = options.map((o) => {
        const opt = o as Record<string, unknown>;
        return { ...opt, label: String(opt.label).slice(0, 120), value: String(opt.value ?? opt.label).slice(0, 400) };
      });
    }
    if (type === "list") {
      const items = Array.isArray(block.items) ? block.items.filter((it) => it && typeof it === "object" && typeof (it as { title?: unknown }).title === "string") : [];
      if (!items.length) continue;
      block.items = items.slice(0, 20);
    }
    if (type === "card" && !Array.isArray(block.fields)) block.fields = [];
    out.push(block);
    if (out.length >= MAX_BLOCKS) break;
  }
  return out;
}

/** "sale_price" → "Sale price". */
export function humanise(key: string): string {
  const s = key.replace(/_/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * One row per slot for the summary card: defaults marked "(default)", record-filled values tagged,
 * hidden plumbing keys left out, in a stable order (the `order` list first, then the rest).
 */
export function rowsFromSlots(
  slots: Record<string, string>,
  opts: { labels?: Record<string, string>; hidden?: Iterable<string>; defaults?: Iterable<string>; fromRecord?: Iterable<string>; order?: string[]; max?: number } = {}
): CardRow[] {
  const hidden = new Set(opts.hidden ?? []);
  const defaults = new Set(opts.defaults ?? []);
  const record = new Set(opts.fromRecord ?? []);
  const keys = Object.keys(slots).filter((k) => !hidden.has(k) && !/_id$/.test(k) && k !== "confirmed" && slots[k] !== "");
  const order = opts.order ?? [];
  keys.sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 1e9 : ia) - (ib === -1 ? 1e9 : ib);
    return 0;
  });
  return keys.slice(0, opts.max ?? 40).map((k) => ({
    key: k,
    label: opts.labels?.[k] ?? humanise(k),
    value: defaults.has(k) ? `${slots[k]} (default)` : slots[k],
    source: defaults.has(k) ? "default" : record.has(k) ? "record" : "user",
  }));
}

export type { UiBlock };
