/**
 * typed-prompt.ts — load only the entity type that's in play.
 *
 * A chat is about ONE entity type (one product line, one document kind), but a prompt that
 * carries every type's workflow and every type's validate/preview/create tool schemas on every
 * model call is 2–3x the size it needs to be. Prompt size drives time-to-first-token and the
 * provider's tokens-per-minute limit, so the runtime sends: the shared skills + the domain's
 * core skill + ONLY the current type's skill, and the common tools + ONLY that type's tools.
 * (Measured: 103k → 44k chars per call, suite 681 s → 479 s, rate-limit waits 40 → 0.)
 *
 * How the type gets set:
 *  1. From the user's own words at the start of a turn (manifest keywords) — no model call.
 *  2. Restored from the draft (the last validate_* tool) for resumed sessions.
 *  3. By the model, through the runtime-provided `set_type` tool — for unclear openers and for
 *     mid-flow switches. A switch also clears the draft in code, the way a form resets.
 *
 * Once a type is set the tool's enum EXCLUDES it — models otherwise call it "to be safe" on a
 * type that is already loaded (27 of 37 calls in the first run), a whole round-trip for nothing.
 *
 * Domains opt in with `types` in domain.json. AGENT_TYPED_PROMPT=false restores load-everything.
 */
import type { DomainManifest, PreviewState } from "@marg/types";
import { behaviour } from "./otel.js";
import type { ToolDef } from "./llm.js";
import { log } from "./logger.js";
import type { Session } from "./session.js";

export function typedEnabled(domain: DomainManifest): boolean {
  return Boolean(domain.types && Object.keys(domain.types).length) && process.env.AGENT_TYPED_PROMPT !== "false";
}

export const typeToolName = (domain: DomainManifest): string => domain.type_tool ?? "set_type";

export const typeTitle = (domain: DomainManifest, type: string): string => domain.types?.[type]?.title ?? type.charAt(0).toUpperCase() + type.slice(1);

/** Which type owns this tool (validate_office_slots → "office"); undefined for common tools. */
export function typeFromTool(domain: DomainManifest, toolName: string | undefined): string | undefined {
  if (!toolName || !domain.types) return undefined;
  return Object.entries(domain.types).find(([, t]) => t.tools.includes(toolName))?.[0];
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The type the user's words point to, or undefined when they point to none or more than one. A message that is just a type's name always counts. */
export function detectType(domain: DomainManifest, text: string): string | undefined {
  if (!domain.types) return undefined;
  const t = text.trim().toLowerCase();
  if (!t) return undefined;
  const hits = Object.entries(domain.types)
    .filter(([name, def]) => {
      if (t === name || t === (def.title ?? "").toLowerCase()) return true;
      return (def.keywords ?? []).some((k) => new RegExp(`(^|[^\\p{L}])${escapeRe(k.toLowerCase())}s?([^\\p{L}\\p{N}]|$)`, "u").test(t));
    })
    .map(([name]) => name);
  return hits.length === 1 ? hits[0] : undefined;
}

/** The runtime-provided tool the model uses to set or switch the type. Not an MCP tool — handled in the agent loop. */
export function setTypeToolDef(domain: DomainManifest, current?: string): ToolDef {
  const names = Object.keys(domain.types ?? {}).filter((n) => n !== current);
  return {
    type: "function",
    function: {
      name: typeToolName(domain),
      description: current
        ? `The type is already set to ${typeTitle(domain, current)}, and its workflow and tools are loaded — never call this to confirm or re-set it. Call it ONLY when the user changes to a DIFFERENT type mid-chat; the draft then resets.`
        : "No type is set yet. Call this FIRST, as soon as the user's words make the type clear — it loads that type's workflow and its validate/preview/create tools, and you continue in the same turn. If the type is unclear, ask the user instead.",
      parameters: {
        type: "object",
        properties: { type: { type: "string", enum: names, description: `One of: ${names.join(", ")}.` } },
        required: ["type"],
        additionalProperties: false,
      },
    },
  };
}

/** Tools the model sees for this type: set-type first, then the common tools and the type's own. */
export function toolsForType(domain: DomainManifest, all: ToolDef[], type: string | undefined): ToolDef[] {
  const typed = new Set(Object.values(domain.types ?? {}).flatMap((t) => t.tools));
  const mine = new Set(type ? (domain.types?.[type]?.tools ?? []) : []);
  return [setTypeToolDef(domain, type), ...all.filter((t) => !typed.has(t.function.name) || mine.has(t.function.name))];
}

/** Settle the type at the start of a turn, without a model call. */
export function resolveTypeAtTurnStart(domain: DomainManifest, session: Session, userMessage: string): string | undefined {
  if (session.activeType && domain.types?.[session.activeType]) return session.activeType;
  const restored = typeFromTool(domain, session.preview?.tool);
  const type = restored ?? detectType(domain, userMessage);
  if (type) {
    session.activeType = type;
    if (session.preview) session.preview.entity_type = type;
    log.debug("type set at turn start", { session: session.id, type, source: restored ? "draft" : "user words" });
  }
  return type;
}

export interface TypeSwitch {
  result: string;
  changed: boolean;
  preview?: PreviewState;
}

/** Handle a set_type call. Returns undefined when `toolName` is some other tool. */
export function handleTypeTool(domain: DomainManifest, session: Session, toolName: string, args: Record<string, unknown>): TypeSwitch | undefined {
  if (toolName !== typeToolName(domain)) return undefined;
  const names = Object.keys(domain.types ?? {});
  const type = String(args.type ?? "").trim().toLowerCase();
  if (!names.includes(type)) return { changed: false, result: `ERROR: unknown type "${String(args.type ?? "")}". Use one of: ${names.join(", ")}.` };
  const prev = session.activeType;
  if (prev === type) return { changed: false, result: `The type is already ${typeTitle(domain, type)} — its workflow and tools are loaded. Carry on.` };
  session.activeType = type;
  const def = domain.types![type];
  let result = `Type set to ${typeTitle(domain, type)}. The ${typeTitle(domain, type)} workflow is now in your instructions and its tools are available: ${def.tools.join(", ")}. Continue in this same turn.`;
  let preview: PreviewState | undefined;
  if (prev || session.preview) {
    const validateTool = def.tools.find((t) => t.startsWith("validate")) ?? def.tools[0];
    preview = { tool: validateTool, state: "gathering", slots: {}, missing: [], entity_type: type };
    session.preview = preview;
    result += ` The previous${prev ? ` ${typeTitle(domain, prev)}` : ""} draft has been cleared, the way a form resets on a type change: tell the user in one line that you're starting the ${typeTitle(domain, type)} flow afresh.`;
  }
  log.info("type changed", { session: session.id, from: prev ?? null, to: type });
  behaviour("type_changed", { type, from: prev ?? "none" });
  return { changed: true, result, preview };
}
