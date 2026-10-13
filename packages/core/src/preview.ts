/**
 * preview.ts — the draft as the runtime understands it, read off the tool calls.
 *
 * The slot set a validate_* / preview_* / create_* tool receives IS the draft as the agent
 * currently understands it — the user's own answers, so safe to reflect back to that user's
 * client as the "form filling itself" pane. We project a bounded copy of primitives and
 * primitive arrays (joined for display), plus the validator's problems as `missing`.
 *
 * MERGE vs REPLACE. A `validate_*` call is made mid-conversation with whatever the agent holds
 * at that moment and may omit slots established earlier, so its args MERGE onto the prior draft.
 * `preview_*` / `create_*` carry the complete payload, so those REPLACE it (which is also how
 * a mid-flow correction drops stale slots). Failed calls emit nothing (the state didn't advance).
 *
 * Also here: the completion signal (a write tool returning `created:true` + a real id) and the
 * draft fingerprint the confirm gate compares against.
 */
import { createHash } from "node:crypto";
import type { Completion, PreviewState } from "@marg-adk/types";

export const SLOT_CAP = 60;
export const SLOT_VALUE_CAP = 200;

export const WRITE_TOOL = /^(create|submit|book|apply|order|send|publish|place)_/;
export const DRAFT_TOOL = /^(validate|preview|create|submit|book|apply|order|send|publish|place)_/;

/** The write-success signal in a tool result: `created:true` (or `ok:true` with an id) and a real id. */
export function detectCompletion(toolName: string, resultText: string, idKey = "entity_id"): Completion | undefined {
  if (!WRITE_TOOL.test(toolName)) return undefined;
  try {
    const r = JSON.parse(resultText) as Record<string, unknown>;
    const id = r?.[idKey] ?? r?.entity_id ?? r?.id;
    if ((r?.created === true || r?.submitted === true) && id) {
      return {
        entity_id: String(id),
        entity_url: typeof r.entity_url === "string" ? r.entity_url : undefined,
        upload_link: typeof r.upload_link === "string" ? r.upload_link : undefined,
        label: typeof r.label === "string" ? r.label : undefined,
      };
    }
  } catch {
    /* not JSON / partial — no completion, which is safe */
  }
  return undefined;
}

/** A stable fingerprint of the user-facing slots — what the summary card was shown for. */
export function draftFingerprint(slots: Record<string, string>): string {
  const keys = Object.keys(slots).filter((k) => k !== "confirmed").sort();
  return createHash("sha1").update(keys.map((k) => `${k}=${slots[k]}`).join("\n")).digest("hex").slice(0, 16);
}

/**
 * Build the next draft state from one tool call. Returns undefined for non-draft tools, empty
 * slot sets, failed calls, and MCP errors (an "ERROR" / "MCP error" result must never read as a
 * successful validate).
 */
export function detectPreview(toolName: string, args: Record<string, unknown>, resultText: string, created: boolean, prior?: PreviewState): PreviewState | undefined {
  if (!DRAFT_TOOL.test(toolName)) return undefined;
  if (/^ERROR/.test(resultText) || /MCP error -?\d+/.test(resultText)) return undefined;
  const slots: Record<string, string> = {};
  const refs: Record<string, string> = {};
  let count = 0;
  for (const [k, v] of Object.entries(args)) {
    if (k === "confirmed" || k === "variant" || k === "master_overrides" || v == null) continue;
    if (/_id$/.test(k)) {
      if (typeof v === "string" && v.trim()) refs[k] = v.trim();
      continue;
    }
    const t = typeof v;
    const joinable = Array.isArray(v) && v.length > 0 && v.every((x) => ["string", "number"].includes(typeof x));
    if (t !== "string" && t !== "number" && t !== "boolean" && !joinable) continue;
    const s = (joinable ? (v as unknown[]).join(", ") : String(v)).trim();
    if (!s) continue;
    slots[k] = s.length > SLOT_VALUE_CAP ? s.slice(0, SLOT_VALUE_CAP) + "…" : s;
    if (++count >= SLOT_CAP) break;
  }
  const validate = toolName.startsWith("validate");
  if (!count && !validate) return undefined;
  let merged: Record<string, string> = { ...slots };
  let mergedRefs: Record<string, string> = { ...refs };
  if (validate && prior) {
    const all = { ...prior.slots, ...slots };
    delete all.confirmed;
    const keys = Object.keys(all);
    merged = keys.length > SLOT_CAP ? Object.fromEntries(keys.slice(-SLOT_CAP).map((k) => [k, all[k]])) : all;
    mergedRefs = { ...(prior.refs ?? {}), ...refs };
  }
  let missing: string[] = [];
  let defaults: string[] = prior?.defaults ?? [];
  let fromRecord: string[] = prior?.from_record ?? [];
  if (validate) {
    try {
      const r = JSON.parse(resultText) as Record<string, unknown>;
      const problems = r?.problems ?? r?.missing;
      if (Array.isArray(problems)) missing = problems.slice(0, 20).map(String);
      // a validator may apply defaults and fill from a record: it says so and the pane marks them
      if (r?.defaults && typeof r.defaults === "object" && !Array.isArray(r.defaults)) {
        for (const [k, v] of Object.entries(r.defaults as Record<string, unknown>)) {
          if (merged[k] === undefined && v != null && String(v).trim()) {
            merged[k] = String(v);
            if (!defaults.includes(k)) defaults = [...defaults, k];
          }
        }
      }
      if (r?.from_record && typeof r.from_record === "object" && !Array.isArray(r.from_record)) {
        for (const [k, v] of Object.entries(r.from_record as Record<string, unknown>)) {
          if (v != null && String(v).trim()) {
            merged[k] = String(v);
            if (!fromRecord.includes(k)) fromRecord = [...fromRecord, k];
          }
        }
      }
      // a slot the user set is no longer a default
      defaults = defaults.filter((k) => !(k in slots));
    } catch {
      /* non-JSON validate result — treat as no problem list */
    }
  }
  const state: PreviewState["state"] = created ? "created" : missing.length ? "gathering" : "validated";
  const next: PreviewState = {
    tool: toolName,
    state,
    slots: merged,
    missing,
    ...(Object.keys(mergedRefs).length ? { refs: mergedRefs } : {}),
    ...(defaults.length ? { defaults } : {}),
    ...(fromRecord.length ? { from_record: fromRecord } : {}),
  };
  // runtime state rides along the draft (steps, edit, identity, type) — never lost on a validate
  if (prior) {
    if (prior.steps) next.steps = prior.steps;
    if (prior.edit) next.edit = prior.edit;
    if (prior.identity) next.identity = prior.identity;
    if (prior.entity_type) next.entity_type = prior.entity_type;
    // the summary stays "shown" only while the draft is the one it was shown for
    if (prior.summary_shown && prior.summary_slots === draftFingerprint(merged)) {
      next.summary_shown = true;
      next.summary_slots = prior.summary_slots;
    }
  }
  return next;
}
