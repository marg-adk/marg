/**
 * forms.ts — the `form` ui block and its reply format.
 *
 * A form block is a card of rows the user fills in place: each row has a key, a label, a
 * kind (pick / multi / text / num / area), options for picks, a pre-filled value and whether
 * it is required. The client renders the rows and, on submit, sends ONE message in the wire
 * format below; the runtime parses it back into {key: value} — the model never does.
 *
 * Wire format (what the widget sends, what `parseFormReply` reads):
 *   "<label> [<key>]: <value>; <label> [<key>]: <value>; …"
 * Human-readable, so a transcript still makes sense; the KEY in brackets removes any
 * ambiguity. A reply without keys (a typed answer in the same shape) is parsed by label.
 *
 * The user's own bubble shows a readable echo ("Details confirmed: Billing · High") composed
 * by the client from the rows' `say` templates — `formEcho` is the reference implementation
 * the widget mirrors, so tests can pin the wording.
 *
 * Pure functions.
 */
import type { FormBlock, FormRow } from "@marg/types";

export type { FormBlock, FormRow };

const PAIR_RE = /^\s*([^:[\]]+?)\s*(?:\[([a-z0-9_]+)\])?\s*:\s*(.*?)\s*$/is;

/** The message a client sends for the filled rows. */
export function formReply(rows: FormRow[], values: Record<string, string>): string {
  return rows
    .filter((r) => values[r.key] !== undefined && String(values[r.key]).trim() !== "")
    .map((r) => `${r.label} [${r.key}]: ${String(values[r.key]).replace(/;/g, ",").trim()}`)
    .join("; ");
}

/**
 * {key: value} from a form reply. Pairs are split on "; " (a value never carries a semicolon —
 * the client replaces them). A pair names the key in brackets, else its label is matched
 * against the block's rows (case-insensitive); an unknown label is ignored. Returns undefined
 * when the text is not a form reply at all.
 */
export function parseFormReply(text: string, rows: FormRow[] = []): Record<string, string> | undefined {
  const byLabel = new Map(rows.map((r) => [r.label.trim().toLowerCase(), r.key]));
  const out: Record<string, string> = {};
  let pairs = 0;
  for (const part of text.split(/;\s*/)) {
    const m = PAIR_RE.exec(part);
    if (!m) continue;
    const key = m[2] ?? byLabel.get(m[1].trim().toLowerCase());
    if (!key) continue;
    pairs++;
    out[key] = m[3];
  }
  return pairs > 0 ? out : undefined;
}

/** Is this message a form reply (at least one bracketed key)? Cheap check before parsing. */
export function looksLikeFormReply(text: string): boolean {
  return /\[[a-z0-9_]+\]\s*:/i.test(text);
}

/** The rows still missing after a submit — required rows with no value. */
export function missingRows(rows: FormRow[], values: Record<string, string>): FormRow[] {
  return rows.filter((r) => r.required && !(values[r.key] ?? r.value ?? "").trim());
}

/** Validate a submit against the rows: pick/multi values must be options; num rows numeric. Returns per-key error text. */
export function validateFormValues(rows: FormRow[], values: Record<string, string>): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const r of rows) {
    const v = (values[r.key] ?? "").trim();
    if (!v) continue;
    if ((r.kind === "pick" || r.kind === "multi") && r.options?.length) {
      const allowed = new Set(r.options.map((o) => o.value.toLowerCase()));
      const labels = new Map(r.options.map((o) => [o.label.toLowerCase(), o.value]));
      const picks = r.kind === "multi" ? v.split(/,\s*/) : [v];
      const bad = picks.filter((p) => !allowed.has(p.toLowerCase()) && !labels.has(p.toLowerCase()));
      if (bad.length) errors[r.key] = `Not an option: ${bad.join(", ")}`;
    }
    if (r.kind === "num" && !/^[\d.,]+\s*[a-zA-Z%]*$/.test(v)) errors[r.key] = "Enter a number";
  }
  return errors;
}

/** Canonical option value for a pick (accepts the label too). */
export function canonicalPick(row: FormRow, value: string): string {
  const v = value.trim();
  const hit = row.options?.find((o) => o.value.toLowerCase() === v.toLowerCase() || o.label.toLowerCase() === v.toLowerCase());
  return hit ? hit.value : v;
}

/**
 * The readable echo of a submit: "<echo>: 2 bathrooms · floor 4 · …". `say` templates:
 * `{v}` = the chosen option's label / the typed value; `{other_key}` = another row's value;
 * `{zero?, one?, many}` for counts; "" leaves the row out; no `say` ⇒ "Label: value".
 */
export function formEcho(block: FormBlock, values: Record<string, string>): string {
  const parts: string[] = [];
  const labelOf = (r: FormRow, v: string): string => r.options?.find((o) => o.value === v || o.label === v)?.label ?? v;
  const fill = (tpl: string, r: FormRow, v: string): string =>
    tpl.replace(/\{([a-z0-9_]+)\}/gi, (_m, k: string) => {
      if (k === "v") return labelOf(r, v);
      const other = block.rows.find((x) => x.key === k);
      const ov = values[k] ?? other?.value ?? "";
      return other ? labelOf(other, ov) : "";
    });
  for (const r of block.rows) {
    const v = (values[r.key] ?? "").trim();
    if (!v) continue;
    if (r.say === "") continue;
    if (typeof r.say === "string") {
      parts.push(fill(r.say, r, v));
    } else if (r.say && typeof r.say === "object") {
      const n = Number(v);
      const tpl = n === 0 && r.say.zero ? r.say.zero : n === 1 && r.say.one ? r.say.one : r.say.many ?? "{v}";
      parts.push(fill(tpl, r, v));
    } else {
      parts.push(`${r.label}: ${labelOf(r, v)}`);
    }
  }
  const body = parts.filter(Boolean).join(" · ");
  return block.echo ? `${block.echo}: ${body}` : body;
}
