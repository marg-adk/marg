import type { ChipsBlock } from "@marg-adk/types";

/**
 * sections.ts — the review's "Change something" as a section picker (pure).
 *
 * Once every step has ended the draft closes with the summary card. "Change something" is the
 * RUNTIME's: it draws one chip per section that exists (the steps that settled), reads the pick
 * by its WHOLE content, re-opens THAT step's own card pre-filled through the step's existing draw,
 * and returns to the summary when it settles. While a section is open nothing arms the create
 * gate and a typed "yes" is not an answer.
 */

export interface SectionDef {
  key: string;
  label: string;
}

export const NOTHING_VALUE = "Nothing to change";
export const OTHER_VALUE = "Something else";

export const sectionValue = (label: string): string => `Edit ${label}`;

export const sectionPickerLead = (identity?: string): string => `${identity ? `${identity}. ` : ""}Which part would you like to change?`;
export const sectionPickerStill = "The sections below are still open — pick the part you'd like to change.";
export const yesAtPicker = "Pick the part you'd like to change below, or tap Nothing to change.";
export const yesIgnored = (label: string, still: string): string => `The ${label.toLowerCase()} step is still open — finish it below first; I'll ask before creating anything. ${still}`.trim();
export const EDIT_LEAD = (label: string): string => `Edit ${label.toLowerCase()}:`;
export const updatedLine = (label: string, fact?: string): string => `${label} updated${fact ? ` — ${fact.replace(/\.$/, "")}` : ""}.`;

/** The picker: one chip per offered section, plus "Something else" and "Nothing to change". */
export function sectionPickerBlock(offered: readonly SectionDef[], opts: { other?: boolean } = {}): ChipsBlock {
  return {
    type: "chips",
    edit_sections: true,
    limit: 12,
    step: "edit",
    options: [...offered.map((s) => ({ label: s.label, value: sectionValue(s.label) })), ...(opts.other === false ? [] : [{ label: OTHER_VALUE, value: OTHER_VALUE, ghost: true }]), { label: NOTHING_VALUE, value: NOTHING_VALUE, ghost: true }],
  };
}

export type EditRead = { type: "menu" } | { type: "section"; section: string } | { type: "none" } | { type: "other" } | { type: "words" };

const norm = (s: string): string => s.toLowerCase().replace(/[’‘`´']/g, "").replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/\s+/g, " ").trim();
const VERBS = new Set("change changes edit edits update updates modify revise redo fix correct amend alter replace".split(" "));
const FILL = new Set(("please pls plz kindly the a an my our i id ill want wanna would like to lets let us me need can could just now also and or for of in on some more another other new one it this that make " +
  "section sections part parts info information details detail card step thing things something anything which want").split(" "));
const CONNECTIVES = new Set("and or the a an of to for with".split(" "));
const MENU_NOUNS = new Set("something anything section sections part parts things thing details".split(" "));
const NONE_RE = /^(?:(?:no|nope|nah|nothing|none)(?: (?:thanks|thank you|more|else|to change|needed|at all|change|changes))*|never ?mind|nevermind|cancel|back|go back|keep (?:it )?(?:as is|as it is|everything|all)|leave (?:it )?(?:as is|alone)|all good|looks good|its fine|no changes?|nothing to change)$/;

/**
 * What a typed or tapped message asks for, read by its WHOLE content: a chip's value ("Edit
 * Priority"), "change the priority", "edit details", "change something", "nothing to change".
 * Every word must be a verb, a filler or a word of ONE offered section's label; anything else (a
 * figure, a question, two sections, a name) is words — the model answers it. `picking`: the picker
 * is up, so a bare section name is the pick and a "no" is "nothing to change".
 */
export function readEdit(msg: string, offered: readonly SectionDef[], picking = false): EditRead {
  const raw = (msg ?? "").trim();
  if (!raw || raw.length > 120 || /\?/.test(raw)) return { type: "words" };
  const text = norm(raw);
  if (!text) return { type: "words" };
  if (picking && NONE_RE.test(text)) return { type: "none" };
  if (text === norm(NOTHING_VALUE)) return { type: "none" };
  if (picking && (text === norm(OTHER_VALUE) || /^(?:(?:i want to |id like to |i would like to |let me |i need to )?(?:change |edit |update )?)?(?:something|anything|one thing|a thing|some thing) else(?: please)?$/.test(text))) return { type: "other" };
  const words = text.split(" ").filter(Boolean);
  // a section's label words are its own even when they are generic elsewhere ("Details", "Key features");
  // only pure connectives never count as a label word
  const labelWords = offered.map((s) => new Set(norm(s.label).split(" ").filter((w) => w && !CONNECTIVES.has(w))));
  const named = new Set(labelWords.flatMap((s) => [...s]));
  // a label word shared by two sections is not distinctive
  const distinctive = labelWords.map((set, i) => new Set([...set].filter((w) => !labelWords.some((o, j) => j !== i && o.has(w)))));
  let verb = false;
  let menuNoun = false;
  const found = new Set<number>();
  for (const w of words) {
    if (VERBS.has(w)) {
      verb = true;
      continue;
    }
    const owners = distinctive.map((d, i) => (d.has(w) ? i : -1)).filter((i) => i >= 0);
    if (owners.length === 1) {
      found.add(owners[0]);
      continue;
    }
    if (owners.length > 1) return { type: "words" };
    if (named.has(w)) return { type: "words" }; // a label word two sections share, on its own: ambiguous
    if (MENU_NOUNS.has(w)) {
      menuNoun = true;
      continue;
    }
    if (FILL.has(w)) continue;
    return { type: "words" };
  }
  if (found.size > 1) return { type: "words" };
  if (found.size === 1) {
    if (!verb && !picking) return { type: "words" };
    return { type: "section", section: offered[[...found][0]].key };
  }
  if (verb || (menuNoun && picking)) return { type: "menu" };
  return { type: "words" };
}
