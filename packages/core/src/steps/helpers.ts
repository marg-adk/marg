/**
 * steps/helpers.ts — building blocks for step definitions: a chips step, a form step, a
 * multi-pick step. Most domains compose their steps from these three; a bespoke step implements
 * StepDefinition directly (see docs/guides/new-step.md).
 */
import type { ChipsBlock, FormBlock, FormRow, MultichipsBlock, UiOption } from "@marg-adk/types";
import { formEcho, looksLikeFormReply, missingRows, parseFormReply, validateFormValues, canonicalPick } from "../forms.js";
import { readChoice } from "../readers.js";
import { CONFIRM_WORDS, NEUTRAL, wordsOf } from "../reply-words.js";
import type { StepContext, StepDefinition, StepRead } from "./types.js";

/** Options for a chips step: static, or fetched (a reference-data tool, a search). */
export type OptionsSource = UiOption[] | ((ctx: StepContext) => Promise<UiOption[]> | UiOption[]);

async function resolveOptions(src: OptionsSource, ctx: StepContext): Promise<UiOption[]> {
  return typeof src === "function" ? src(ctx) : src;
}

/**
 * ONE question answered by a tap (or typed words naming exactly one option). The settled value
 * is written to `slot`. The reply is read by its whole content: an option's value or label, or a
 * message whose every other word is filler.
 */
export function chipsStep(def: {
  key: string;
  label: string;
  slot: string;
  lead: string | ((ctx: StepContext) => string);
  options: OptionsSource;
  /** Say-line after a settle; `{v}` = the picked label. */
  say?: string;
  optional?: boolean;
  owed?: StepDefinition["owed"];
  applies?: StepDefinition["applies"];
  asksLike?: RegExp;
  dependsOn?: string[];
  /** A value the user already said in words settles the step without asking (returns the option or undefined). */
  alreadySaid?: (ctx: StepContext, options: UiOption[]) => UiOption | undefined;
}): StepDefinition {
  return {
    key: def.key,
    label: def.label,
    optional: def.optional,
    owed: def.owed,
    applies: def.applies,
    asksLike: def.asksLike,
    dependsOn: def.dependsOn,
    owns: [def.slot],
    still: `The ${def.label.toLowerCase()} question below is still open.`,
    async draw(ctx) {
      const options = await resolveOptions(def.options, ctx);
      const current = ctx.state?.values?.[def.slot] ?? ctx.draft.slots[def.slot];
      const block: ChipsBlock = { type: "chips", options: options.map((o) => ({ ...o, ...(current && (o.value === current || o.label === current) ? { sel: true } : {}) })) };
      return { lead: typeof def.lead === "function" ? def.lead(ctx) : def.lead, ui: [block], state: { options }, note: `Options offered: ${options.map((o) => o.label).join(", ")}.` };
    },
    async read(ctx, message) {
      const options = (ctx.state?.options as UiOption[] | undefined) ?? (await resolveOptions(def.options, ctx));
      const r = readChoice(message, options, { picking: true });
      if (r.type === "pick") return { type: "settle", values: { [def.slot]: r.option.value }, via: "answer" };
      return { type: "words" };
    },
    async settle(ctx, read) {
      const v = read.values[def.slot];
      const options = (ctx.state?.options as UiOption[] | undefined) ?? (await resolveOptions(def.options, ctx));
      const label = options.find((o) => o.value === v)?.label ?? v;
      return { say: (def.say ?? `${def.label}: {v}.`).replace("{v}", label), slots: { [def.slot]: v }, note: `${def.label} = ${label}.` };
    },
  };
}

/**
 * Several picks from a list, with a minimum and optional own entries. Settled as a comma-joined
 * list in `slot` (the carry rule restores it as a string; domains that need an array split it).
 */
export function multiStep(def: {
  key: string;
  label: string;
  slot: string;
  lead: string | ((ctx: StepContext) => string);
  options: OptionsSource;
  min?: number;
  max?: number;
  own?: { max: number; placeholder?: string };
  optional?: boolean;
  owed?: StepDefinition["owed"];
  applies?: StepDefinition["applies"];
  asksLike?: RegExp;
  dependsOn?: string[];
}): StepDefinition {
  const min = def.min ?? 1;
  return {
    key: def.key,
    label: def.label,
    optional: def.optional,
    owed: def.owed,
    applies: def.applies,
    asksLike: def.asksLike,
    dependsOn: def.dependsOn,
    owns: [def.slot],
    still: `The ${def.label.toLowerCase()} picks below are still open — Done when they are right.`,
    async draw(ctx) {
      const options = await resolveOptions(def.options, ctx);
      const held = (ctx.state?.values?.[def.slot] ?? ctx.draft.slots[def.slot] ?? "").split(/,\s*/).filter(Boolean);
      const block: MultichipsBlock = { type: "multichips", min, max: def.max, submit: "Done", own: def.own, options: options.map((o) => ({ ...o, ...(held.includes(o.label) || held.includes(o.value) ? { sel: true } : {}) })) };
      const extra = held.filter((h) => !options.some((o) => o.label === h || o.value === h)).map((h) => ({ label: h, value: h, sel: true, own: true }));
      block.options = [...block.options, ...extra] as UiOption[];
      return { lead: typeof def.lead === "function" ? def.lead(ctx) : def.lead, ui: [block], state: { options } };
    },
    async read(ctx, message) {
      const options = (ctx.state?.options as UiOption[] | undefined) ?? (await resolveOptions(def.options, ctx));
      // Done sends the picked labels joined ", "; a typed list reads the same way
      const parts = message.split(/[,;|\n•·]+/).map((s) => s.trim()).filter(Boolean);
      if (!parts.length) return { type: "words" };
      const picks: string[] = [];
      for (const p of parts) {
        const hit = options.find((o) => o.label.toLowerCase() === p.toLowerCase() || o.value.toLowerCase() === p.toLowerCase());
        if (hit) picks.push(hit.label);
        else if (def.own && p.length <= def.own.max && wordsOf(p).length <= 6 && !wordsOf(p).every((w) => NEUTRAL.has(w) || CONFIRM_WORDS.has(w))) picks.push(p);
        else return { type: "words" };
      }
      const unique = [...new Set(picks)];
      if (unique.length < min) return { type: "redraw", say: `Pick at least ${min} — you have ${unique.length}.`, state: { values: { [def.slot]: unique.join(", ") } } };
      return { type: "settle", values: { [def.slot]: unique.slice(0, def.max ?? 50).join(", ") }, via: "picks" };
    },
    settle(_ctx, read) {
      const v = read.values[def.slot];
      const n = v.split(/,\s*/).filter(Boolean).length;
      return { say: `${def.label}: ${n} picked.`, slots: { [def.slot]: v }, note: `${def.label} = ${v}.` };
    },
  };
}

/**
 * A card of rows the user fills in place (the runtime's form block). Rows may be pre-filled from
 * the draft (`value` from the slot of the same key) or from a record. Required rows gate the
 * submit; a partial submit is drawn again with the missing rows marked.
 */
export function formStep(def: {
  key: string;
  label: string;
  title?: string | ((ctx: StepContext) => string);
  lead: string | ((ctx: StepContext) => string);
  rows: FormRow[] | ((ctx: StepContext) => Promise<FormRow[]> | FormRow[]);
  submit?: string;
  echo?: string;
  optional?: boolean;
  owed?: StepDefinition["owed"];
  applies?: StepDefinition["applies"];
  asksLike?: RegExp;
  dependsOn?: string[];
  /** Validate the submitted values; return per-key errors to redraw. */
  check?: (values: Record<string, string>, ctx: StepContext) => Record<string, string>;
}): StepDefinition {
  const rowsFor = async (ctx: StepContext): Promise<FormRow[]> => {
    const rows = typeof def.rows === "function" ? await def.rows(ctx) : def.rows;
    const pending = (ctx.state?.pending as Record<string, string> | undefined) ?? {};
    const errors = (ctx.state?.errors as Record<string, string> | undefined) ?? {};
    return rows.map((r) => {
      const value = pending[r.key] ?? ctx.state?.values?.[r.key] ?? r.value ?? ctx.draft.slots[r.key];
      return { ...r, ...(value !== undefined ? { value } : {}), ...(errors[r.key] ? { error: errors[r.key] } : {}) };
    });
  };
  return {
    key: def.key,
    label: def.label,
    optional: def.optional,
    owed: def.owed,
    applies: def.applies,
    asksLike: def.asksLike,
    dependsOn: def.dependsOn,
    owns: typeof def.rows === "function" ? undefined : def.rows.map((r) => r.key),
    still: `The ${def.label.toLowerCase()} card below is still open — ${def.submit ?? "Done"} when it is right.`,
    async draw(ctx) {
      const rows = await rowsFor(ctx);
      const block: FormBlock = { type: "form", title: typeof def.title === "function" ? def.title(ctx) : def.title ?? def.label, submit: def.submit ?? "Done", rows, echo: def.echo ?? `${def.label} confirmed` };
      return { lead: typeof def.lead === "function" ? def.lead(ctx) : def.lead, ui: [block], state: { rows }, note: `The card's rows: ${rows.map((r) => r.key).join(", ")}.` };
    },
    async read(ctx, message): Promise<StepRead> {
      const rows = (ctx.state?.rows as FormRow[] | undefined) ?? (await rowsFor(ctx));
      if (!looksLikeFormReply(message)) return { type: "words" };
      const values = parseFormReply(message, rows) ?? {};
      for (const r of rows) if (r.kind === "pick" && values[r.key]) values[r.key] = canonicalPick(r, values[r.key]);
      const errors = { ...validateFormValues(rows, values), ...(def.check ? def.check(values, ctx) : {}) };
      const missing = missingRows(rows, values);
      for (const m of missing) errors[m.key] ??= "Required";
      if (Object.keys(errors).length) return { type: "redraw", say: `${Object.keys(errors).length} row${Object.keys(errors).length === 1 ? "" : "s"} to fix.`, state: { pending: values, errors } };
      return { type: "settle", values, via: "submit" };
    },
    settle(ctx, read) {
      const rows = (ctx.state?.rows as FormRow[] | undefined) ?? [];
      const block: FormBlock = { type: "form", rows, echo: def.echo ?? `${def.label} confirmed` };
      const say = formEcho(block, read.values) || `${def.label} confirmed.`;
      return { say: say.endsWith(".") ? say : `${say}.`, slots: read.values, note: Object.entries(read.values).map(([k, v]) => `${k} = ${v}`).join(", ") };
    },
  };
}
