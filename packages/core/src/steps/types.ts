/**
 * steps/types.ts — the contract of a runtime-owned step.
 *
 * THE PATTERN (ADR-0004): the model owns the conversation; the runtime owns the MOMENTS that
 * must be right. A step is such a moment: the runtime draws the ask (a form, chips, a list),
 * reads the reply in code by its whole content, writes the result to the draft, carries it into
 * every later tool call, and tells the model what happened in one runtime fact. The model never
 * asks the question, never draws the block, never reads the answer.
 *
 * Why: a prompt rule lowers how often a model slips; it never reaches zero. Measured on a
 * production journey, model-led asks were skipped 25–50% of the time, model-attested values were
 * invented 1 in 64 chats, and prompt wording leaked into narration. In code the step holds for
 * every model in the chain.
 *
 * A step definition is pure where it can be: `read` and `settle` take the message and the draft,
 * and return what to write. Side effects (a tool call to fetch options) go through `ctx.call`.
 */
import type { DomainManifest, PreviewState, StepState, UiBlock } from "@marg/types";
import type { Session } from "../session.js";

export type StepVia = "moment" | "late" | "edit" | "redraw";

export interface StepContext {
  domain: DomainManifest;
  session: Session;
  /** The draft (session.preview) — always present (an empty one is created when missing). */
  draft: PreviewState;
  /** This step's own state (undefined before its first draw). */
  state?: StepState;
  /** The entity type in play (typed domains). */
  type?: string;
  /** Call a domain tool as this user (internal_* tools included). Returns the tool's text. */
  call(tool: string, args: Record<string, unknown>): Promise<string>;
  /** Parse a JSON tool result; undefined when it is not JSON or is an error. */
  json(text: string): any;
  /** Every user message so far (typed text and tapped values), oldest first — for "did they say it in words" checks. */
  userWords(): string[];
}

export interface StepDraw {
  /** The lead line the user reads above the block (one short sentence). */
  lead: string;
  ui: UiBlock[];
  /** Extra state to store with the ask (stage, scratch); merged over {status:"asked", asked:n+1, open}. */
  state?: Partial<StepState>;
  /** The runtime fact for the model while this ask is open (appended to the prompt tail). */
  note?: string;
}

export type StepRead =
  | { type: "settle"; values: Record<string, string>; via?: string }
  | { type: "skip" }
  /** Draw the ask again (a partial form, a value out of range): `state` carries what the redraw needs (errors, pending values). */
  | { type: "redraw"; say?: string; state?: Partial<StepState> }
  /** Content the reader cannot take: the model answers it, the runtime draws the ask again under the answer. */
  | { type: "words" };

export interface StepSettled {
  /** The one-line acknowledgement the user reads ("Priority set to High."). */
  say: string;
  /** Slot writes on the draft (display values) — also what the carry rule restores into tool calls. */
  slots?: Record<string, string>;
  /** The runtime fact for the model after the settle (what was settled, never to ask again). */
  note?: string;
}

export interface StepDefinition {
  /** Stable key ("priority", "details", "visibility"). */
  key: string;
  /** What the user calls it (the review's section picker: "Edit Priority"). */
  label: string;
  /** Does the step apply to this draft at all (default: always)? */
  applies?(ctx: StepContext): boolean;
  /**
   * Is the step owed now? Default: once every earlier step has ended and the draft is valid (the
   * model finished gathering slots — `missing` is empty). Return false to wait.
   */
  owed?(ctx: StepContext): boolean;
  /** Draw the ask. `via` says why: the chain reached it, a late draw under the model's reply, the review re-opening it, or a redraw. */
  draw(ctx: StepContext, via: StepVia): Promise<StepDraw> | StepDraw;
  /** Read a reply while the ask is open — by its WHOLE content. */
  read(ctx: StepContext, message: string): StepRead | Promise<StepRead>;
  /** Apply a settle: write the draft, say one line, tell the model. */
  settle(ctx: StepContext, read: Extract<StepRead, { type: "settle" }>, via: StepVia): Promise<StepSettled> | StepSettled;
  /** What a skip says (optional steps). */
  skipped?(ctx: StepContext): StepSettled;
  /** Slot keys this step owns: the carry rule restores them into every validate/preview/create call; the model's own values for them are overridden. */
  owns?: string[];
  /** A model sentence that asks this step's question is cut from its reply (one question per turn — the runtime asks it). */
  asksLike?: RegExp;
  /** Steps whose change re-opens this one (by key). */
  dependsOn?: string[];
  /** The user may skip the step (a Skip chip / a typed "skip"). */
  optional?: boolean;
  /** The line drawn above the ask when it is drawn again under a side answer. */
  still?: string;
  /** Identity the step belongs to (e.g. the main record's id slot): a change of it resets the step. Default: the draft's `identity`. */
  identityKey?: string;
}

/** The runtime's own reply for a turn it answered without the model. */
export interface RuntimeTurn {
  reply: string;
  ui: UiBlock[];
  /** The step (or "confirm" / "edit") that answered. */
  kind: string;
  /** Low-cardinality event name for telemetry ("settled", "skipped", "redrawn", "drawn"…). */
  event: string;
}
