/**
 * readers.ts — reading a user's reply in code, by its WHOLE content.
 *
 * The runtime owns moments where getting it wrong costs: a confirmation, a pick from a list, a
 * number, a form. For those, the model never reads the reply — these functions do, and anything
 * they cannot read with confidence is "words": the model answers it while the runtime draws its
 * question again. Every reader follows the same rule as reply-words.ts: every word must be
 * accounted for, or it is content.
 */
import type { UiOption } from "@marg-adk/types";
import { CONFIRM_WORDS, NEUTRAL, isPlainNo, isPlainSkip, isPlainYes, isQuestionShaped, wordsOf } from "./reply-words.js";

export type YesNoRead = "yes" | "no" | "skip" | "words";

/** A yes / no / skip / anything else, read by the whole message. `extraYes` are this question's own go-ahead words. */
export function readYesNo(text: string, extraYes: Iterable<string> = [], opts: { strict?: boolean } = {}): YesNoRead {
  if (isPlainSkip(text)) return "skip";
  if (isPlainYes(text, extraYes, { strict: opts.strict })) return "yes";
  if (isPlainNo(text)) return "no";
  return "words";
}

export const norm = (s: string): string => s.toLowerCase().normalize("NFKC").replace(/[’‘`´']/g, "").replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/\s+/g, " ").trim();

const PICK_FILL = new Set("the a an this that one option please pls plz go with choose select pick take i want i'd like id like lets let's its it is yes ok okay make it set to use prefer go for".split(" "));

export type ChoiceRead = { type: "pick"; value: string; option: UiOption } | { type: "none" } | { type: "words" };

/**
 * A pick from the offered options: the option's value or label (a tap sends the value), or a
 * message whose every word is filler plus the DISTINCTIVE words of exactly one option ("the
 * second one" is words; "billing" picks Billing; "billing or technical?" is words). `picking`:
 * the list is up, so a lone noun counts and "none"/"nothing" means no pick.
 */
export function readChoice(text: string, options: UiOption[], opts: { picking?: boolean; none?: RegExp } = {}): ChoiceRead {
  const raw = (text ?? "").trim();
  if (!raw || raw.length > 160 || isQuestionShaped(raw)) return { type: "words" };
  const t = norm(raw);
  if (opts.picking && (opts.none ?? /^(?:none|nothing|no|nope|neither|not these|none of (?:these|them|those)|skip)$/).test(t)) return { type: "none" };
  const byValue = options.find((o) => norm(o.value) === t || norm(o.label) === t);
  if (byValue) return { type: "pick", value: byValue.value, option: byValue };
  // distinctive tokens per option: label words not shared with another option
  const tokensOf = (o: UiOption) => norm(o.label).split(" ").filter((w) => w.length > 1 && !PICK_FILL.has(w));
  const all = options.map(tokensOf);
  const distinctive = all.map((toks, i) => toks.filter((w) => !all.some((other, j) => j !== i && other.includes(w))));
  const words = t.split(" ").filter(Boolean);
  const hits = new Set<number>();
  for (const w of words) {
    const owners = distinctive.map((d, i) => (d.includes(w) ? i : -1)).filter((i) => i >= 0);
    if (owners.length === 1) {
      hits.add(owners[0]);
      continue;
    }
    if (owners.length > 1) return { type: "words" };
    if (!PICK_FILL.has(w) && !NEUTRAL.has(w) && !CONFIRM_WORDS.has(w)) return { type: "words" };
  }
  if (hits.size !== 1) return { type: "words" };
  const option = options[[...hits][0]];
  // a bare noun outside the picker is a remark unless it covers the option's distinctive words fully
  return { type: "pick", value: option.value, option };
}

/** A lone number (with an optional unit word), else undefined. "3 bathrooms" → 3; "make it 3" → undefined. */
export function readNumber(text: string): number | undefined {
  const m = /^\s*([+-]?\d+(?:[.,]\d+)?)\s*(?:[\p{L}%]+)?\s*$/u.exec(text ?? "");
  if (!m) return undefined;
  const n = Number(m[1].replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
}

/** Magnitude words → multipliers. Extend for a locale with `readAmount(text, { units })`. */
export const DEFAULT_UNITS: Record<string, number> = {
  k: 1e3, thousand: 1e3, thousands: 1e3,
  lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, l: 1e5,
  million: 1e6, millions: 1e6, m: 1e6, mn: 1e6,
  crore: 1e7, crores: 1e7, cr: 1e7,
  billion: 1e9, billions: 1e9, bn: 1e9, b: 1e9,
};

export interface AmountRead {
  amount: number;
  /** The magnitude word used, if any. */
  unit?: string;
  /** "a month", "per year", "per sqft" … the period or basis words that followed. */
  basis?: string;
  raw: string;
}

/**
 * The first money-like figure in a message: digits with optional thousands separators and a
 * magnitude word ("1.8 cr", "85k", "2,50,000", "$1,200/mo"). Returns undefined when nothing
 * reads as an amount. The caller decides whether a bare number is ambiguous (ask once).
 */
export function readAmount(text: string, opts: { units?: Record<string, number> } = {}): AmountRead | undefined {
  const units = opts.units ?? DEFAULT_UNITS;
  const unitRe = Object.keys(units).sort((a, b) => b.length - a.length).join("|");
  const re = new RegExp(`(?:[₹$€£]\\s*)?(\\d{1,3}(?:[,\\s]\\d{2,3})+|\\d+)(?:\\.(\\d+))?\\s*(${unitRe})?\\b(?:\\s*(?:/|per|a|an)\\s*(month|mo|year|yr|annum|week|day|sqft|sq ft|sq m|hour|hr))?`, "i");
  const m = re.exec(text ?? "");
  if (!m) return undefined;
  const whole = m[1].replace(/[,\s]/g, "");
  const n = Number(whole + (m[2] ? "." + m[2] : ""));
  if (!Number.isFinite(n)) return undefined;
  const unit = m[3]?.toLowerCase();
  const mult = unit ? units[unit] ?? 1 : 1;
  return { amount: Math.round(n * mult), unit, basis: m[4]?.toLowerCase(), raw: m[0].trim() };
}

/** Every word of the message is in `allowed` (plus fillers). The generic "all words accounted for" check. */
export function allWordsIn(text: string, allowed: Iterable<string>): boolean {
  const ok = new Set([...allowed].map((w) => w.toLowerCase()));
  const words = wordsOf(text);
  return words.length > 0 && words.every((w) => ok.has(w) || NEUTRAL.has(w));
}
