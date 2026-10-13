/**
 * guards.ts — the rules the runtime enforces in code on the model's tool calls.
 *
 * A prompt rule lowers how often a model slips; a guard makes the rule hold for every model.
 * Each guard cites what it stops: the create gate (the model attests `confirmed:true` on its
 * own — seen live: after the summary the user sent a change and the model created anyway);
 * attested lists (a model invented list items published under the user's name 1 in 64 chats
 * even with a note covering that exact case).
 *
 * The write gate exists THREE times, and never weakens: the skill rule, the tool's own
 * `confirmed:true` + AGENT_ALLOW_WRITES check, and this runtime guard that reads the user's
 * LAST message by its whole content and requires the summary to have been shown for THIS draft.
 */
import type { ChatMessage } from "./llm.js";
import { behaviour } from "./otel.js";
import { log } from "./logger.js";
import { VALUE_NOUNS, isPlainYes } from "./reply-words.js";
import { WRITE_TOOL } from "./preview.js";

const guardsOff = (): boolean => process.env.AGENT_GUARDS === "false";

// ---- the create gate ---------------------------------------------------------------
/** The words that ARE a go-ahead at the gate (beside the yes words) — never the soft acknowledgements. */
const CREATE_ANCHORS = "create publish submit book apply send order place proceed confirm go".split(" ");
/** Allowed beside a yes, never a go-ahead on their own. */
const CREATE_FILL = "it this that the listing entry ticket record order request booking application live creating created creation post save launch finalize finalise to now lets let us all quickly fast ready checked verified reviewed approve approved want awesome excellent satisfied set have ahead".split(" ");

/** The whole message is a plain go-ahead for the write ("yes, create it", "go ahead", "ok submit it"). */
export function isCreateYes(text: string): boolean {
  const t = String(text ?? "").trim();
  if (/^\s*no\s+changes?\s*[.!]*$/i.test(t)) return false;
  if (/\blet\s+(?:it|this|that)\s+be\b|\blet\s+go\b(?!\s+(?:ahead|on)\b)/i.test(t)) return false;
  return isPlainYes(t, [...CREATE_ANCHORS, ...CREATE_FILL], { without: new Set([...VALUE_NOUNS, ..."high low above below".split(" ")]), anchors: CREATE_ANCHORS, strict: true });
}

/**
 * Refuse a write unless the summary was shown for the current draft AND the user's last message
 * is a plain yes. Returns the ERROR text to hand the model (never the tool), or undefined to allow.
 */
export function guardCreate(toolName: string, messages: ChatMessage[], summaryShown: boolean): string | undefined {
  if (guardsOff() || !WRITE_TOOL.test(toolName)) return undefined;
  const last = [...messages].reverse().find((m) => m.role === "user" && typeof m.content === "string");
  const text = String(last?.content ?? "").trim();
  const affirmative = isCreateYes(text);
  if (affirmative && summaryShown) return undefined;
  log.warn("create guard refused the call", { tool: toolName, last: text.slice(0, 120), affirmative, summary_shown: summaryShown });
  behaviour("create_refused", { tool: toolName, guard: "confirm_gate", affirmative, summary_shown: summaryShown });
  return !summaryShown
    ? `ERROR: User confirmation required. The summary for the current draft has not been shown yet — finish gathering, validate, and stop; the runtime draws the summary card and asks the user. Call ${toolName} only after their explicit yes to it.`
    : `ERROR: User confirmation required. Their last message ("${text.slice(0, 100)}") is not a yes — it is a change, a question or a detail. Apply it to the draft (validate again) and stop; the runtime shows the updated summary and asks them to confirm. Call ${toolName} only after an explicit yes.`;
}

// ---- attested lists ----------------------------------------------------------------
const STOP = new Set("the and for with from that this have has are was not yes any all per its our you your also only just please new good nice very high low".split(" "));
const norm = (s: string): string => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
const tokens = (s: string): string[] => norm(s).split(" ").filter((t) => t.length >= 3 && !STOP.has(t));
function sharesStem(a: string, b: string): boolean {
  const n = Math.min(a.length, b.length, 5);
  return n >= 3 && a.slice(0, n) === b.slice(0, n);
}

export interface AttestResult {
  key: string;
  removed: string[];
  kept: string[];
}

/**
 * Drop items of a list-valued argument the user never typed or picked (a value counts as
 * given when its label appears in a user message, or shares a distinctive word stem with one).
 * Errs toward dropping: a false drop costs one extra tap; a false keep publishes a claim the
 * user never made. Mutates `args`. Returns what was dropped, per key.
 */
export function attestedListGuard(toolName: string, args: Record<string, unknown>, messages: ChatMessage[], keys: readonly string[]): AttestResult[] {
  if (guardsOff() || !keys.length || !/^(validate|preview|create|submit)_/.test(toolName)) return [];
  const userText = messages.filter((m) => m.role === "user" && typeof m.content === "string").map((m) => norm(m.content as string)).join(" \n ");
  const userTokens = [...new Set(tokens(userText))];
  const given = (item: unknown): boolean => {
    if (typeof item !== "string") return false;
    const label = norm(item);
    if (!label) return false;
    if (userText.includes(label)) return true;
    return tokens(item).some((ft) => userTokens.some((bt) => sharesStem(ft, bt)));
  };
  const out: AttestResult[] = [];
  for (const key of keys) {
    const raw = args[key];
    if (!Array.isArray(raw) || !raw.length) continue;
    const kept: string[] = [];
    const removed: string[] = [];
    for (const item of raw) (given(item) ? kept : removed).push(String(item));
    if (!removed.length) continue;
    if (kept.length) args[key] = kept;
    else delete args[key];
    log.warn("attested-list guard dropped items the user never gave", { tool: toolName, key, removed: removed.length, kept: kept.length });
    behaviour("attested_dropped", { tool: toolName, guard: key, removed: removed.length, kept: kept.length });
    out.push({ key, removed, kept });
  }
  return out;
}

export function attestNote(results: AttestResult[]): string {
  return results
    .map((g) => `\n\nNOTE FROM THE RUNTIME: these ${g.key} were NOT saved because the user never stated or picked them: ${g.removed.map((f) => `"${f}"`).join(", ")}. Items published under the user's name must come from the user. Offer the options (multichips) and let them choose${g.kept.length ? ` (already saved from the user: ${g.kept.map((f) => `"${f}"`).join(", ")})` : ""}; do not pick for them.`)
    .join("");
}
