/**
 * steps/engine.ts — the turn chain for runtime-owned steps.
 *
 * Two hooks around every model turn:
 *   stepTurn()      BEFORE the model: an open ask is read in code; a settle chains straight into
 *                   the next owed step (or the confirmation summary) in the SAME reply — no model
 *                   call at all. Words the reader cannot take become a runtime fact for the model
 *                   and the ask is drawn again under the model's answer.
 *   finalizeTurn()  AFTER the model: late-draws an owed step under the model's reply (cutting the
 *                   model's own version of the question), draws the summary card when everything
 *                   has settled and the draft is valid, redraws a still-open ask, dedupes.
 *
 * Plus: the carry rule (settled values ride into every validate/preview/create call), the review
 * ("Change something" → a section picker → the step's own card re-opens pre-filled → the summary
 * returns), dependencies (a change of X re-asks Y — BEFORE the summary returns, so the card the user
 * confirms never carries an answer the change made stale), and the open-ask redraw for history replay.
 *
 * Every event is a behaviour() counter + a trace line — a step is not done until it is visible.
 */
import { pathToFileURL } from "node:url";
import { isAbsolute, join } from "node:path";
import type { CardBlock, ChipsBlock, DomainManifest, PreviewState, StepState, UiBlock } from "@marg-adk/types";
import { callDomainTool } from "../mcp-client.js";
import { behaviour, withSpan } from "../otel.js";
import { log } from "../logger.js";
import { draftFingerprint } from "../preview.js";
import { rowsFromSlots } from "../ui-blocks.js";
import { isPlainSkip, isPlainYes } from "../reply-words.js";
import { readChoice } from "../readers.js";
import type { Session } from "../session.js";
import { readEdit, sectionPickerBlock, sectionPickerLead, sectionPickerStill, NOTHING_VALUE, OTHER_VALUE, EDIT_LEAD, reaskedLine, yesAtPicker, yesIgnored, updatedLine } from "../sections.js";
import type { RuntimeTurn, StepContext, StepDefinition, StepDraw, StepRead, StepVia } from "./types.js";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const registry = new Map<string, StepDefinition[]>();

/** Register a domain's step definitions (the gateway does this from the manifest's `steps` module). */
export function registerSteps(domainName: string, defs: StepDefinition[]): void {
  registry.set(domainName, defs);
}
export function registeredSteps(domainName: string): StepDefinition[] {
  return registry.get(domainName) ?? [];
}

/** Load `domain.steps` (a TS/JS module exporting `steps` or a default array) and register it. */
export async function loadDomainSteps(domain: DomainManifest): Promise<StepDefinition[]> {
  if (!domain.steps) return [];
  const path = isAbsolute(domain.steps) ? domain.steps : join(domain.dir, domain.steps);
  const mod = (await import(pathToFileURL(path).href)) as { steps?: StepDefinition[]; default?: StepDefinition[] };
  const defs = mod.steps ?? mod.default ?? [];
  registerSteps(domain.name, defs);
  log.info("steps registered", { domain: domain.name, steps: defs.map((d) => d.key) });
  return defs;
}

// ---------------------------------------------------------------------------
// Context + state helpers
// ---------------------------------------------------------------------------

export const CONFIRM_VALUE = "yes, create it";
export const CHANGE_VALUE = "I want to change something";
export const SKIP_VALUE = "skip";

export function draftOf(session: Session): PreviewState {
  if (!session.preview) session.preview = { tool: "", state: "gathering", slots: {}, missing: [] };
  session.preview.steps ??= {};
  return session.preview;
}

export function stepState(session: Session, key: string): StepState | undefined {
  return session.preview?.steps?.[key];
}

function userWordsOf(session: Session): string[] {
  return session.messages.filter((m) => m.role === "user" && typeof m.content === "string").map((m) => m.content as string);
}

export function makeContext(domain: DomainManifest, session: Session, key?: string): StepContext {
  const draft = draftOf(session);
  return {
    domain,
    session,
    draft,
    state: key ? draft.steps?.[key] : undefined,
    type: session.activeType ?? draft.entity_type,
    call: (tool, args) => callDomainTool(domain.name, tool, args, session.authToken, session.id),
    json: (text) => {
      if (/^ERROR/.test(text) || /MCP error/.test(text)) return undefined;
      try {
        return JSON.parse(text);
      } catch {
        return undefined;
      }
    },
    userWords: () => userWordsOf(session),
  };
}

/** The steps that apply to this session, in journey order. */
export function stepsFor(domain: DomainManifest, session: Session): StepDefinition[] {
  const defs = registeredSteps(domain.name);
  if (!defs.length) return [];
  const type = session.activeType ?? session.preview?.entity_type;
  const order: string[] = (type ? domain.types?.[type]?.steps : undefined) ?? domain.step_order ?? defs.map((d) => d.key);
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const ctx = makeContext(domain, session);
  return order.map((k) => byKey.get(k)).filter((d): d is StepDefinition => Boolean(d) && (!d!.applies || d!.applies(ctx)));
}

const ended = (st?: StepState): boolean => st?.status === "settled" || st?.status === "skipped";

/** The step whose ask is open right now. */
export function openStep(domain: DomainManifest, session: Session): StepDefinition | undefined {
  return stepsFor(domain, session).find((s) => stepState(session, s.key)?.status === "asked");
}

/** The next step owed: every earlier step ended, this one not yet started, and its `owed` (default: the draft is valid) holds. */
export function nextOwed(domain: DomainManifest, session: Session): StepDefinition | undefined {
  const draft = draftOf(session);
  if (draft.state === "created" || session.completion) return undefined;
  for (const step of stepsFor(domain, session)) {
    const st = stepState(session, step.key);
    if (ended(st)) continue;
    if (st?.status === "asked") return undefined; // an open ask comes first
    const ctx = makeContext(domain, session, step.key);
    const owed = step.owed ? step.owed(ctx) : draft.missing.length === 0 && draft.state !== "gathering";
    return owed ? step : undefined;
  }
  return undefined;
}

export function allStepsEnded(domain: DomainManifest, session: Session): boolean {
  return stepsFor(domain, session).every((s) => ended(stepState(session, s.key)));
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

function tagged(ui: UiBlock[], key: string): UiBlock[] {
  return ui.map((b) => ({ ...b, step: key }) as UiBlock);
}

function withSkip(step: StepDefinition, ui: UiBlock[]): UiBlock[] {
  if (!step.optional) return ui;
  const chips = ui.find((b) => b.type === "chips") as ChipsBlock | undefined;
  if (chips && !chips.options.some((o) => o.value === SKIP_VALUE)) chips.options = [...chips.options, { label: "Skip", value: SKIP_VALUE, ghost: true }];
  else if (!chips) {
    const form = ui.find((b) => b.type === "form" || b.type === "multichips") as { skip?: { label: string; value: string } } | undefined;
    if (form && !form.skip) form.skip = { label: "Skip", value: SKIP_VALUE };
  }
  return ui;
}

/** Draw a step's ask, store the open state, count the event. Returns the runtime turn (lead + ui). */
export async function drawStep(domain: DomainManifest, session: Session, step: StepDefinition, via: StepVia, extraState?: Partial<StepState>): Promise<{ turn: RuntimeTurn; draw: StepDraw }> {
  const ctx = makeContext(domain, session, step.key);
  // A redraw's state (a partial form's pending values and per-row errors, a multi-pick's picks so
  // far) is what the step draws again, so it must be on the context BEFORE draw() runs — it used
  // to be merged into the stored state only after, and a partial submit came back empty and
  // unmarked (seen on the playground, 2026-10-14).
  if (extraState && ctx.state) ctx.state = { ...ctx.state, ...extraState };
  const draw = await withSpan(`runtime.step.draw ${step.key}`, { attrs: { "agent.step": step.key, "agent.step.via": via } }, () => step.draw(ctx, via));
  const prev = ctx.draft.steps![step.key];
  const ui = withSkip(step, tagged(draw.ui, step.key));
  const identityKey = step.identityKey;
  ctx.draft.steps![step.key] = {
    ...(prev?.status === "asked" ? prev : {}),
    ...(via === "edit" && prev ? { before: prev.values } : {}),
    ...(draw.state ?? {}),
    ...(extraState ?? {}),
    status: "asked",
    asked: (prev?.status === "asked" ? prev.asked : 0) + 1,
    open: { lead: draw.lead, ui },
    note: draw.note,
    identity: identityKey ? ctx.draft.slots[identityKey] ?? ctx.draft.refs?.[identityKey] : ctx.draft.identity,
    via,
  };
  const event = via === "moment" ? "drawn" : via === "late" ? "late_draw" : via === "edit" ? "reopened" : "redrawn";
  behaviour("step", { domain: domain.name, step: step.key, type: event, via });
  log.trace("step", { session: session.id, turn: session.turn, step: step.key, event, via });
  return { turn: { reply: draw.lead, ui, kind: step.key, event }, draw };
}

// ---------------------------------------------------------------------------
// The confirmation summary (the built-in last step)
// ---------------------------------------------------------------------------

export function summaryCard(domain: DomainManifest, session: Session): CardBlock {
  const draft = draftOf(session);
  const hidden = new Set(domain.hidden_slots ?? []);
  const rows = rowsFromSlots(draft.slots, { labels: domain.slot_labels, hidden, defaults: draft.defaults, fromRecord: draft.from_record });
  const sections = stepsFor(domain, session)
    .filter((s) => ended(stepState(session, s.key)))
    .map((s) => ({ key: s.key, label: s.label, value: `Edit ${s.label}` }));
  const entity = domain.entity?.singular ?? "entry";
  return {
    type: "card",
    title: `Summary — ${domain.title}`,
    fields: rows,
    actions: [
      { label: `Confirm & create ${entity}`, value: CONFIRM_VALUE },
      { label: "Change something", value: CHANGE_VALUE },
    ],
    sections,
    confirm: true,
  } as CardBlock;
}

export const SUMMARY_LEAD = "Here's everything — please check it. Confirm to create, or change something.";

function drawSummary(domain: DomainManifest, session: Session, via: StepVia): RuntimeTurn {
  const draft = draftOf(session);
  draft.summary_shown = true;
  draft.summary_slots = draftFingerprint(draft.slots);
  draft.edit = undefined;
  behaviour("summary_card", { domain: domain.name, via });
  log.trace("step", { session: session.id, turn: session.turn, step: "confirm", event: "summary", via });
  return { reply: SUMMARY_LEAD, ui: [summaryCard(domain, session)], kind: "confirm", event: "summary" };
}

/** The ready signal: every step ended, the draft is valid, nothing created yet. */
export function summaryDue(domain: DomainManifest, session: Session): boolean {
  const draft = draftOf(session);
  return !session.completion && draft.state === "validated" && draft.missing.length === 0 && allStepsEnded(domain, session) && !openStep(domain, session) && !draft.edit;
}

// ---------------------------------------------------------------------------
// The chain: settle → next owed → … → summary
// ---------------------------------------------------------------------------

async function chainAfter(domain: DomainManifest, session: Session, say: string[], ui: UiBlock[], kind: string, event: string, summaryVia: StepVia = "moment"): Promise<RuntimeTurn> {
  const next = nextOwed(domain, session);
  if (next) {
    const { turn } = await drawStep(domain, session, next, "moment");
    return { reply: [...say, turn.reply].filter(Boolean).join(" "), ui: [...ui, ...turn.ui], kind, event };
  }
  if (summaryDue(domain, session)) {
    const s = drawSummary(domain, session, summaryVia);
    return { reply: [...say, s.reply].filter(Boolean).join(" "), ui: [...ui, ...s.ui], kind, event };
  }
  return { reply: say.join(" "), ui, kind, event };
}

function clearSummary(session: Session): void {
  const draft = draftOf(session);
  draft.summary_shown = false;
  draft.summary_slots = undefined;
}

/** Reset the steps that depend on `changedKey` (and theirs), so they are asked again. */
export function resetDependents(domain: DomainManifest, session: Session, changedKey: string): string[] {
  const reset: string[] = [];
  const draft = draftOf(session);
  const walk = (key: string) => {
    for (const s of registeredSteps(domain.name)) {
      if (s.dependsOn?.includes(key) && draft.steps?.[s.key] && !reset.includes(s.key)) {
        delete draft.steps[s.key];
        reset.push(s.key);
        behaviour("step", { domain: domain.name, step: s.key, type: "reset", via: "edit" });
        log.trace("step", { session: session.id, turn: session.turn, step: s.key, event: "reset", via: "edit", because: changedKey });
        walk(s.key);
      }
    }
  };
  walk(changedKey);
  if (reset.length) clearSummary(session);
  return reset;
}

async function applySettle(domain: DomainManifest, session: Session, step: StepDefinition, read: Extract<StepRead, { type: "settle" }>, via: StepVia, message: string): Promise<{ say: string; reset: string[] }> {
  const ctx = makeContext(domain, session, step.key);
  const settled = await withSpan(`runtime.step.settle ${step.key}`, { attrs: { "agent.step": step.key, "agent.step.via": via } }, () => step.settle(ctx, read, via));
  const draft = ctx.draft;
  const prev = draft.steps![step.key];
  for (const [k, v] of Object.entries(settled.slots ?? {})) {
    if (v === "" || v === undefined) delete draft.slots[k];
    else draft.slots[k] = v;
  }
  draft.steps![step.key] = { ...prev, status: "settled", values: { ...(settled.slots ?? read.values) }, via: read.via ?? "answer", settle_msg: message, note: settled.note, open: undefined };
  clearSummary(session);
  behaviour("step", { domain: domain.name, step: step.key, type: "settled", via });
  log.trace("step", { session: session.id, turn: session.turn, step: step.key, event: "settled", via, keys: Object.keys(settled.slots ?? read.values) });
  let reset: string[] = [];
  if (via === "edit") {
    const changed = Object.keys(settled.slots ?? read.values).filter((k) => prev?.before?.[k] !== (settled.slots ?? read.values)[k]);
    if (changed.length) reset = resetDependents(domain, session, step.key);
  }
  return { say: settled.say, reset };
}

async function applySkip(domain: DomainManifest, session: Session, step: StepDefinition): Promise<string> {
  const ctx = makeContext(domain, session, step.key);
  const prev = ctx.draft.steps![step.key];
  const out = step.skipped ? step.skipped(ctx) : { say: `Skipped ${step.label.toLowerCase()}.` };
  for (const [k, v] of Object.entries(out.slots ?? {})) if (v) ctx.draft.slots[k] = v;
  ctx.draft.steps![step.key] = { ...prev, status: "skipped", values: out.slots ?? {}, via: "skip", note: out.note, open: undefined };
  clearSummary(session);
  behaviour("step", { domain: domain.name, step: step.key, type: "skipped" });
  log.trace("step", { session: session.id, turn: session.turn, step: step.key, event: "skipped" });
  return out.say;
}

// ---------------------------------------------------------------------------
// Pre-model: stepTurn
// ---------------------------------------------------------------------------

export interface PreTurn {
  /** The runtime answered the turn — no model call. */
  turn?: RuntimeTurn;
  /** The model answers, with this fact in its prompt tail; the engine redraws the ask after. */
  note?: string;
  redraw?: { step: string };
}

/** Handle the turn before the model sees it. */
export async function stepTurn(domain: DomainManifest, session: Session, message: string): Promise<PreTurn | undefined> {
  if (session.completion) return undefined;
  const draft = draftOf(session);
  const steps = stepsFor(domain, session);
  if (!steps.length && !draft.summary_shown) return undefined;

  // The review: the section picker is up.
  if (draft.edit?.status === "picking") {
    const offered = steps.filter((s) => ended(stepState(session, s.key)));
    const read = readEdit(message, offered.map((s) => ({ key: s.key, label: s.label })), true);
    if (read.type === "none") {
      draft.edit = undefined;
      const s = drawSummary(domain, session, "edit");
      return { turn: { reply: `Nothing changed. ${s.reply}`, ui: s.ui, kind: "edit", event: "nothing" } };
    }
    if (read.type === "section") {
      const step = offered.find((s) => s.key === read.section)!;
      draft.edit = { status: "open", section: step.key, asked: 1, via: "chip" };
      const { turn } = await drawStep(domain, session, step, "edit");
      return { turn: { reply: `${EDIT_LEAD(step.label)} ${turn.reply}`.trim(), ui: turn.ui, kind: "edit", event: "section" } };
    }
    if (read.type === "other") {
      draft.edit = undefined;
      return { note: "REVIEW (runtime fact): the user wants to change something no section covers. Take the change in words, update the draft with the validate tool, then stop — the runtime draws the summary again." };
    }
    if (read.type === "menu" || isPlainYes(message, [], { strict: true })) {
      draft.edit = { ...draft.edit, asked: draft.edit.asked + 1 };
      return { turn: { reply: isPlainYes(message, [], { strict: true }) ? yesAtPicker : sectionPickerStill, ui: [sectionPickerBlock(offered.map((s) => ({ key: s.key, label: s.label })))], kind: "edit", event: "redrawn" } };
    }
    return { note: "REVIEW (runtime fact): the section picker is open under your reply. Answer the user's words in one line and stop; the runtime draws the picker again.", redraw: { step: "edit" } };
  }

  // An open ask: read it in code.
  const open = openStep(domain, session);
  if (open) {
    const editing = draft.edit?.status === "open" && draft.edit.section === open.key;
    const ctx = makeContext(domain, session, open.key);
    if (open.optional && (message.trim().toLowerCase() === SKIP_VALUE || isPlainSkip(message))) {
      const say = await applySkip(domain, session, open);
      if (editing) {
        draft.edit = undefined;
        const s = drawSummary(domain, session, "edit");
        return { turn: { reply: `${say} ${s.reply}`, ui: s.ui, kind: "edit", event: "skipped" } };
      }
      return { turn: await chainAfter(domain, session, [say], [], open.key, "skipped") };
    }
    const read = await withSpan(`runtime.step.read ${open.key}`, { attrs: { "agent.step": open.key } }, () => open.read(ctx, message));
    if (read.type === "settle") {
      const { say, reset } = await applySettle(domain, session, open, read, editing ? "edit" : "moment", message);
      if (editing) {
        draft.edit = undefined;
        // A changed answer may have reset the steps that depend on it: the chain asks the first of them
        // again, and the summary returns only after the last is answered — never over a stale answer.
        const labels = stepsFor(domain, session).filter((s) => reset.includes(s.key)).map((s) => s.label);
        return { turn: await chainAfter(domain, session, [updatedLine(open.label, say), ...(labels.length ? [reaskedLine(labels)] : [])], [], "edit", "settled", "edit") };
      }
      return { turn: await chainAfter(domain, session, [say], [], open.key, "settled") };
    }
    if (read.type === "skip") {
      const say = await applySkip(domain, session, open);
      return { turn: await chainAfter(domain, session, [say], [], open.key, "skipped") };
    }
    if (read.type === "redraw") {
      const { turn } = await drawStep(domain, session, open, "redraw", read.state);
      return { turn: { reply: [read.say, turn.reply].filter(Boolean).join(" "), ui: turn.ui, kind: open.key, event: "redrawn" } };
    }
    // words beside the open ask: a typed yes while a step is open is not an answer either
    if (isPlainYes(message, [], { strict: true })) {
      const { turn } = await drawStep(domain, session, open, "redraw");
      return { turn: { reply: yesIgnored(open.label, open.still ?? turn.reply), ui: turn.ui, kind: open.key, event: "yes_ignored" } };
    }
    behaviour("step", { domain: domain.name, step: open.key, type: "words_beside" });
    return { note: openNote(open, draft.steps![open.key]), redraw: { step: open.key } };
  }

  // The summary is up: "Change something" opens the review; a yes is the model's cue to create.
  if (draft.summary_shown) {
    const offered = steps.filter((s) => ended(stepState(session, s.key)));
    const read = offered.length ? readEdit(message, offered.map((s) => ({ key: s.key, label: s.label })), false) : { type: "words" as const };
    if (message.trim() === CHANGE_VALUE || read.type === "menu") {
      if (!offered.length) return { note: "REVIEW (runtime fact): the user wants to change something. Take the change in words, update the draft with the validate tool, then stop — the runtime draws the summary again." };
      draft.edit = { status: "picking", asked: 1, via: message.trim() === CHANGE_VALUE ? "chip" : "words" };
      draft.summary_shown = false;
      behaviour("review", { domain: domain.name, type: "picker" });
      return { turn: { reply: sectionPickerLead(), ui: [sectionPickerBlock(offered.map((s) => ({ key: s.key, label: s.label })))], kind: "edit", event: "picker" } };
    }
    if (read.type === "section") {
      const step = offered.find((s) => s.key === read.section)!;
      draft.edit = { status: "open", section: step.key, asked: 1, via: "words" };
      draft.summary_shown = false;
      const { turn } = await drawStep(domain, session, step, "edit");
      return { turn: { reply: `${EDIT_LEAD(step.label)} ${turn.reply}`.trim(), ui: turn.ui, kind: "edit", event: "section" } };
    }
  }
  return undefined;
}

function openNote(step: StepDefinition, st: StepState): string {
  const own = st.note ? ` ${st.note}` : "";
  return `STEP "${step.label}" (runtime fact): the runtime's ask for ${step.label.toLowerCase()} is open under your reply and the user wrote words instead of answering it. Answer them in ONE line and stop — never ask ${step.label.toLowerCase()} yourself, never draw chips or a form for it; the runtime draws its ask again under your reply.${own}`;
}

/** The runtime facts for the model's prompt tail this turn: the open ask (if any) and every settled step. */
export function stepNotes(domain: DomainManifest, session: Session): string {
  const draft = session.preview;
  if (!draft?.steps) return "";
  const lines: string[] = [];
  const steps = stepsFor(domain, session);
  const open = steps.find((s) => draft.steps![s.key]?.status === "asked");
  for (const s of steps) {
    const st = draft.steps[s.key];
    if (!st || s === open) continue;
    if (st.status === "settled") {
      const vals = Object.entries(st.values ?? {}).map(([k, v]) => `${k} = ${v}`).join(", ");
      lines.push(`- ${s.label}: settled by the runtime (${vals || "done"}). Never ask it again; the runtime carries these values into every tool call.${st.note ? ` ${st.note}` : ""}`);
    } else if (st.status === "skipped") {
      lines.push(`- ${s.label}: the user skipped it. Never ask it again.`);
    }
  }
  const pending = steps.filter((s) => !draft.steps![s.key]);
  if (pending.length && !session.completion) {
    lines.push(`- Still to come, asked BY THE RUNTIME under your reply when the draft is valid: ${pending.map((s) => s.label.toLowerCase()).join(", ")}. Never ask these yourself and never announce them; gather the slots and validate.`);
  }
  if (draft.summary_shown) lines.push(`- The runtime has drawn the confirmation summary card with every row. A plain yes from the user means "create it": call the create tool with confirmed:true. Never draw another summary.`);
  if (!lines.length && !open) return "";
  const head = "\n\n---\n\nRUNTIME-OWNED STEPS (facts, not instructions to repeat): the runtime draws these asks itself, reads the answers in code, and tells you here.\n";
  return head + lines.join("\n") + (open ? `\n${openNote(open, draft.steps[open.key])}` : "");
}

// ---------------------------------------------------------------------------
// Post-model: finalizeTurn
// ---------------------------------------------------------------------------

function withoutAsks(reply: string, like: RegExp | undefined): string {
  const sentences = reply.split(/(?<=[.?!])\s+|\n/).filter((s) => s.trim());
  const kept = sentences.filter((s) => !(like && like.test(s) && (/\?\s*$/.test(s.trim()) || /\b(choose|select|pick|tell me|let me know|share|provide|which|what|please)\b/i.test(s))));
  return (kept.length ? kept : sentences.slice(0, 1)).join(" ").trim();
}

function hasActionCard(ui: unknown[]): boolean {
  return ui.some((b) => (b as { type?: string; actions?: unknown[] })?.type === "card" && Array.isArray((b as { actions?: unknown[] }).actions) && ((b as { actions?: unknown[] }).actions?.length ?? 0) > 0);
}

/** Post-model: late draws, the summary, redraws. Returns the final reply + ui and what the runtime did. */
export async function finalizeTurn(domain: DomainManifest, session: Session, reply: string, ui: UiBlock[], pre: PreTurn | undefined): Promise<{ reply: string; ui: UiBlock[]; kind?: string; events: string[] }> {
  const events: string[] = [];
  const draft = draftOf(session);
  if (session.completion) return { reply, ui, events };
  const steps = stepsFor(domain, session);

  // 1. an ask stayed open while the model answered side words → draw it again under the answer
  if (pre?.redraw) {
    if (pre.redraw.step === "edit" && draft.edit?.status === "picking") {
      const offered = steps.filter((s) => ended(stepState(session, s.key)));
      events.push("edit_redrawn");
      return { reply: `${reply} ${sectionPickerStill}`.trim(), ui: [...ui.filter((b) => b.type !== "chips" && b.type !== "form"), sectionPickerBlock(offered.map((s) => ({ key: s.key, label: s.label })))], kind: "edit", events };
    }
    const open = steps.find((s) => s.key === pre.redraw!.step && stepState(session, s.key)?.status === "asked");
    if (open) {
      const { turn } = await drawStep(domain, session, open, "redraw");
      events.push("redrawn");
      const clean = withoutAsks(reply, open.asksLike);
      return { reply: `${clean} ${open.still ?? turn.reply}`.trim(), ui: [...ui.filter((b) => b.type !== "chips" && b.type !== "form" && b.type !== "multichips"), ...turn.ui], kind: open.key, events };
    }
  }

  // 2. a step is owed now → late draw under the model's reply (its own question cut)
  const owed = nextOwed(domain, session);
  if (owed) {
    const { turn } = await drawStep(domain, session, owed, "late");
    events.push("late_draw");
    const clean = withoutAsks(reply, owed.asksLike);
    const keptUi = ui.filter((b) => !["chips", "form", "multichips", "list", "toggles"].includes(b.type) && !(b.type === "card" && (b as CardBlock).actions?.length));
    return { reply: `${clean} ${turn.reply}`.trim(), ui: [...keptUi, ...turn.ui], kind: owed.key, events };
  }

  // 3. everything settled and the draft is valid → the runtime's summary card (the model's own card, if any, is replaced)
  if (summaryDue(domain, session) && !draft.summary_shown) {
    const s = drawSummary(domain, session, "late");
    events.push("summary");
    const keptUi = ui.filter((b) => !(b.type === "card" && (b as CardBlock).actions?.length) && b.type !== "chips");
    const clean = withoutAsks(reply, /\b(confirm|summary|correct|create|submit|go ahead|proceed)\b/i);
    return { reply: `${clean || reply} ${hasActionCard(ui) ? "" : s.reply}`.trim(), ui: [...keptUi, ...s.ui], kind: "confirm", events };
  }
  return { reply, ui, events };
}

// ---------------------------------------------------------------------------
// The carry rule + the open-ask redraw for history
// ---------------------------------------------------------------------------

/** Before a validate/preview/create call: settled step values override the model's version of those keys (the model's own guess never stands). */
export function carryStepValues(domain: DomainManifest, session: Session, args: Record<string, unknown>): string[] {
  const draft = session.preview;
  if (!draft?.steps) return [];
  const carried: string[] = [];
  for (const step of registeredSteps(domain.name)) {
    const st = draft.steps[step.key];
    if (st?.status !== "settled" || !st.values) continue;
    for (const k of step.owns?.length ? step.owns : Object.keys(st.values)) {
      const v = st.values[k];
      if (v === undefined) continue;
      if (args[k] === undefined || String(args[k]) !== String(v)) {
        args[k] = v;
        carried.push(k);
      }
    }
  }
  if (carried.length) behaviour("carry", { domain: domain.name, type: "restored" });
  return carried;
}

/** What a reload must draw again on the last assistant entry: the open ask, the picker, or the summary. */
export function openAskUi(domain: DomainManifest, session: Session): { lead?: string; ui: unknown[] } | undefined {
  const draft = session.preview;
  if (!draft || session.completion) return undefined;
  const steps = stepsFor(domain, session);
  if (draft.edit?.status === "picking") {
    const offered = steps.filter((s) => ended(stepState(session, s.key)));
    return { lead: sectionPickerLead(), ui: [sectionPickerBlock(offered.map((s) => ({ key: s.key, label: s.label })))] };
  }
  const open = steps.find((s) => draft.steps?.[s.key]?.status === "asked");
  if (open?.key && draft.steps?.[open.key]?.open) return { lead: draft.steps[open.key].open!.lead, ui: draft.steps[open.key].open!.ui };
  if (draft.summary_shown) return { lead: SUMMARY_LEAD, ui: [summaryCard(domain, session)] };
  return undefined;
}

/** For the section picker: which option did a message pick (shared with the readers). */
export const pickFromOptions = readChoice;
export { NOTHING_VALUE, OTHER_VALUE };
