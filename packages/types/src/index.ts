/**
 * @marg-adk/types — the shapes every package agrees on.
 *
 * WHAT THIS IS: the domain manifest (what a drop-in domain folder declares), the client
 * protocol (ui blocks, stream events, the preview pane, completion), and the state the
 * runtime keeps per session for its own steps. Domain-internal types (your slots, your
 * identity record) stay inside your domain; only genuinely shared shapes live here.
 */

// ---------------------------------------------------------------------------
// Domain manifest
// ---------------------------------------------------------------------------

/** One entity type / variant a domain can work on (a product line, a document kind, a property type). */
export interface TypeDef {
  /** Human title ("Home", "Refund request"). */
  title?: string;
  /** The skill folder (relative to the domain dir) loaded ONLY when this type is in play. */
  skill: string;
  /** The MCP tools that belong to this type (its validate/preview/create triad and type-only reads). */
  tools: string[];
  /** Words in the user's opening message that select this type without a model call. */
  keywords?: string[];
  /** Runtime-owned steps enabled for this type (keys of the domain's step definitions), in journey order. */
  steps?: string[];
  /** Fields the user may hide on a public record (a visibility step offers one switch each). */
  hideable?: string[];
  /** Any other flag your steps read (data, not code). */
  [flag: string]: unknown;
}

/** A domain module, as declared by its `domain.json` and enriched at discovery. */
export interface DomainManifest {
  /** Machine name, unique across installed domains (e.g. "support-intake"). */
  name: string;
  /** Human title for UIs and the prompt identity line. */
  title: string;
  /** One-line capability description — the router's domain card AND the capabilities statement. */
  description: string;
  /** Extra routing signal for the super agent (and for the Verdict choice question). */
  route_hints?: { examples?: string[]; keywords?: string[] };
  /** How to spawn this domain's MCP server (stdio). Args are relative to the repo root. */
  mcp: { command: string; args: string[] };
  /** Domain-specific skill directories, relative to the domain root. */
  skills: string[];
  /** Names of shared skills (under shared-skills/) to inject into this domain's prompt. */
  shared_skills?: string[];
  /** Path (relative to domain root) to this domain's eval scenarios, if any. */
  evals?: string;
  /** Skills always loaded when `types` is used (the orchestrator core); the type's own skill joins it. */
  core_skills?: string[];
  /** Entity types / variants: ONLY the in-play type's skill and tools are sent to the model. */
  types?: Record<string, TypeDef>;
  /** Name of the runtime-provided tool the model calls to set or switch the type (default "set_type"). */
  type_tool?: string;
  /** Module path (relative to the domain root) exporting the domain's runtime-owned step definitions. */
  steps?: string;
  /** Module path (relative to the domain root) registering a scripted mock model (`LLM_CHAIN=mock`) — the offline journey for demos, evals and CI. */
  mock?: string;
  /** Runtime-owned steps for a domain without `types`, in journey order (keys of the step definitions). */
  step_order?: string[];
  /** Slot labels for the preview pane and the summary card (slot key → label). Falls back to the key. */
  slot_labels?: Record<string, string>;
  /** Slots the summary card never shows (ids, plumbing). */
  hidden_slots?: string[];
  /** List-valued arguments that may only contain items the user typed or picked (the attested-list guard). */
  attested_lists?: string[];
  /** How the write tools and the completion are named (defaults: create_* or submit_*, and entity_id). */
  entity?: { singular?: string; plural?: string; id_key?: string };
  /** Absolute path to the domain directory — filled in by discovery, never authored. */
  dir: string;
}

// ---------------------------------------------------------------------------
// Usage, caps, completion
// ---------------------------------------------------------------------------

/** One cap's standing, shown to the user alongside replies. */
export interface CapStanding {
  scope: string;
  limit_tokens: number;
  used_tokens: number;
  remaining_tokens: number;
  /** Seconds until the window resets; null for lifetime (per-session) caps. */
  resets_in_s: number | null;
  /** 0–100, the only number a user is shown. */
  percent: number;
}

/** Token utilisation attached to a turn for user visibility. */
export interface TurnUsage {
  turn_tokens: number;
  session_tokens: number;
  /** Plan tokens: the weighted unit limits are counted in (see docs/METERING.md). */
  turn_plan: number;
  session_plan: number;
  caps: CapStanding[];
}

/**
 * Emitted the moment the write tool returns a real id — the signal that this chat's job is
 * DONE. Drives the widget's end-state and ends the session server-side (further turns are
 * refused except post-create edits). Links are tool-composed or templated, never model-invented.
 */
export interface Completion {
  entity_id: string;
  /** Where the user views the created entity; omitted when no URL template is configured. */
  entity_url?: string;
  /** An external upload / follow-up screen; omitted when unset. */
  upload_link?: string;
  /** Short human label for the end-state card ("Ticket #4821"). */
  label?: string;
  /** Sections that may still be edited after the create (the post-create review). */
  editable?: string[];
}

// ---------------------------------------------------------------------------
// ui blocks — what the model or the runtime may draw
// ---------------------------------------------------------------------------

export interface UiOption {
  label: string;
  value: string;
  /** Drawn de-emphasised (an escape hatch beside the real answers). */
  ghost?: boolean;
  /** Drawn already selected. */
  sel?: boolean;
  /** Drawn disabled with a reason. */
  disabled?: boolean;
  /** Suggested by the runtime (a small marker beside the label). */
  sug?: boolean;
  /** Picking this option also fills other rows of a form (key → value). */
  fills?: Record<string, string>;
}

export interface ChipsBlock {
  type: "chips";
  options: UiOption[];
  /** How many chips a client should draw (default 10). */
  limit?: number;
  /** Tags the runtime sets so evals and clients know which step drew it. */
  step?: string;
  [tag: string]: unknown;
}
export interface MultichipsBlock {
  type: "multichips";
  options: UiOption[];
  min?: number;
  max?: number;
  submit?: string;
  /** Lets the user add their own items: cap per item, placeholder text. */
  own?: { max: number; placeholder?: string };
  /** Draw at most N unpicked options at a time behind a "More" chip. */
  page?: number;
  skip?: { label: string; value: string };
  step?: string;
  [tag: string]: unknown;
}
export interface ListBlock {
  type: "list";
  items: { title: string; subtitle?: string; value: string; ghost?: boolean }[];
  step?: string;
  [tag: string]: unknown;
}
export interface CardRow {
  label: string;
  value: string;
  key?: string;
  /** Where the value came from — the client draws a small tag. */
  source?: "user" | "record" | "default" | "runtime";
}
export interface CardBlock {
  type: "card";
  title?: string;
  fields: CardRow[];
  actions?: UiOption[];
  /** Section chips under the card (the review's "Change something"). */
  sections?: { key: string; label: string; value: string }[];
  /** A low-key offer riding beside a question, not a full card. */
  compact?: boolean;
  [tag: string]: unknown;
}
export interface TogglesBlock {
  type: "toggles";
  submit?: string;
  options: (UiOption & { on?: boolean })[];
  /** The hint under the switches ("ON = hidden"). */
  hint?: string;
  /** Prefix of the message a Done sends ("Hide: a, b"); the "none" text when nothing is on. */
  wire?: { prefix: string; none: string };
  [tag: string]: unknown;
}
export interface LinkBlock {
  type: "link";
  label: string;
  url: string;
}
/** `date` is an ISO day (YYYY-MM-DD): the widget draws a date input; forms.ts validates the shape. */
export type FormRowKind = "pick" | "multi" | "text" | "num" | "area" | "date";
export interface FormRow {
  key: string;
  label: string;
  kind: FormRowKind;
  options?: UiOption[];
  value?: string;
  required?: boolean;
  hint?: string;
  source?: "record" | "heard" | "inferred" | "default";
  unit?: string;
  error?: string;
  /** How the row reads in the user's own confirmation bubble ("{v} bathrooms"); "" leaves it out. */
  say?: string | { zero?: string; one?: string; many?: string };
}
export interface FormBlock {
  type: "form";
  title?: string;
  submit?: string;
  rows: FormRow[];
  /** What the user's confirmation bubble starts with ("Details confirmed"). */
  echo?: string;
  skip?: { label: string; value: string };
  step?: string;
  [tag: string]: unknown;
}
export interface TableBlock {
  type: "table";
  title?: string;
  columns: string[];
  rows: string[][];
  note?: string;
}
export interface ProgressBlock {
  type: "progress";
  title?: string;
  status?: "running" | "ready" | "failed";
  pct?: number;
  stages?: string[];
  stage?: number;
  note?: string;
}
export interface MediaBlock {
  type: "media";
  kind?: "photos" | "plans" | "files";
  title?: string;
  items?: { key: string; url?: string; label?: string; cover?: boolean }[];
  min_recommended?: number;
  note?: string;
  actions?: UiOption[];
  step?: string;
  [tag: string]: unknown;
}
export interface BarsBlock {
  type: "bars";
  title?: string;
  mode?: "range";
  items?: { label: string; sub?: string; value: string; amount: number; accent?: boolean }[];
  low?: { value: string; amount: number; sub?: string };
  median?: { value: string; amount: number };
  high?: { value: string; amount: number; sub?: string };
  you?: { value: string; amount: number; note?: string };
  note?: string;
}
export type UiBlock = ChipsBlock | MultichipsBlock | ListBlock | CardBlock | TogglesBlock | LinkBlock | FormBlock | TableBlock | ProgressBlock | MediaBlock | BarsBlock;

// ---------------------------------------------------------------------------
// Runtime step state + preview (the draft)
// ---------------------------------------------------------------------------

/** The state of one runtime-owned step on the draft. Steps may add their own fields. */
export interface StepState {
  status: "asked" | "settled" | "skipped";
  /** Which sub-question is open when a step asks more than one thing. */
  stage?: string;
  /** How many times the open ask was drawn (1 = first draw). */
  asked: number;
  /** What settled: slot key → display value (the step writes the draft itself). */
  values?: Record<string, string>;
  /** How it ended: a tap, typed words, a form submit, a skip, or already said earlier. */
  via?: string;
  /** The user's message that settled it (so later words can be compared against it). */
  settle_msg?: string;
  /** The open ask as drawn (lead line + block) — replayed on reload. */
  open?: { lead: string; ui: unknown[] };
  /** Identity the step was asked for (a change of the main record resets the step). */
  identity?: string;
  /** The values before a review re-opened the step (dependencies compare against them). */
  before?: Record<string, string>;
  /** The runtime fact for the model while the ask is open / after the settle. */
  note?: string;
  [extra: string]: unknown;
}

/** The review's edit on the draft ("Change something" → a section picker → a step re-opened). */
export interface EditState {
  status: "picking" | "open" | "confirm" | "conflict";
  section?: string;
  asked: number;
  via?: "chip" | "words" | "card";
  /** The edit is on a finished chat's entity (post-create): a settled section is written through, not returned to the create gate. */
  post?: boolean;
  before?: Record<string, string>;
}

/** The draft as the runtime understands it — the slot set the last validate/preview/create call carried, plus runtime state. */
export interface PreviewState {
  tool: string;
  state: "gathering" | "validated" | "created";
  slots: Record<string, string>;
  missing: string[];
  /** Master record references the draft points at (`*_id` keys) — handles for clients, not fields to render. */
  refs?: Record<string, string>;
  /** Slot keys whose value is a declared default (the pane marks them). */
  defaults?: string[];
  /** Slot keys filled from a fetched record rather than the user. */
  from_record?: string[];
  /** The runtime has drawn the confirmation summary for THIS draft (reset when the draft changes). */
  summary_shown?: boolean;
  /** Fingerprint of the slots the summary was shown for. */
  summary_slots?: string;
  /** Runtime-owned steps' state, by step key. */
  steps?: Record<string, StepState>;
  /** Identity of the main record the steps belong to (changes reset dependent steps). */
  identity?: string;
  /** The review edit in progress. */
  edit?: EditState;
  /** The entity type in play (typed prompts). */
  entity_type?: string;
}

// ---------------------------------------------------------------------------
// Replies and stream events (the client protocol)
// ---------------------------------------------------------------------------

/** Who got a turn and why (the super agent's decision). */
export interface TurnRoute {
  domain: string;
  /**
   * The deciding link: `keywords`, `systemone` or `llm` (a typed decision), `sticky` (mid-journey,
   * finished, or a low-confidence pick kept the active domain), `single` (one domain installed),
   * `fallback` (nothing decided; the first domain).
   */
  by: string;
  /** The router's typed decision, when one was made. */
  confidence?: number;
}

/** The step engine's event: a step drawn, redrawn, settled… (`summary` is the confirmation card, step `confirm`). */
export interface TurnStep {
  step: string;
  event: "drawn" | "late_draw" | "redrawn" | "reopened" | "settled" | "skipped" | "summary";
  via?: string;
}

/** One tool call: what the tool received (after the carry rule), what it returned, how long it took. */
export interface TurnTool {
  name: string;
  args: unknown;
  /** The tool's text, masked and clipped. */
  result: string;
  ms: number;
  ok?: boolean;
  /** Keys the runtime restored from settled steps over the model's own values. */
  carried?: string[];
  refused?: "confirm_gate" | "internal";
  /** The runtime's own tool (the entity-type switch), not an MCP call. */
  runtime?: boolean;
}

/** One model call of the turn. */
export interface TurnLlm {
  round: number;
  endpoint?: string;
  model?: string;
  ms: number;
  ttft_ms?: number;
  input: number;
  output: number;
  finish: "stop" | "tool_calls";
}

/**
 * One turn's facts for a dev UI — sent only when the gateway runs with `AGENT_DEV_TRACE=true`
 * (docs/CLIENT-PROTOCOL.md, "The dev trace"). Content: it never reaches telemetry.
 */
export interface TurnTrace {
  /** The session's turn counter — the trace log lines' join key. */
  turn: number;
  route?: TurnRoute;
  steps: TurnStep[];
  tools: TurnTool[];
  llm: TurnLlm[];
}

/** A finished turn as the history endpoint replays it for a dev UI (`turns`). */
export interface TurnRecord {
  turn: number;
  user: string;
  display?: string;
  ms: number;
  domain?: string;
  kind?: string;
  tool_trace: { tool: string; ms: number }[];
  usage?: TurnUsage;
  completion?: Completion;
  trace: TurnTrace;
}

/** The gateway's reply for one user turn. */
export interface AgentReply {
  reply: string;
  ui: unknown[];
  tool_trace: { tool: string; ms: number }[];
  /** Which domain handled this turn (set by the super agent). */
  domain?: string;
  /** A runtime-answered turn names the step that answered it (no model call was made). */
  kind?: string;
  /** Token utilisation for this turn/session; attached by the gateway. */
  usage?: TurnUsage;
  /** Set once, on the turn that created the entity — ends the chat. */
  completion?: Completion;
  /** The dev trace — only when the gateway runs with AGENT_DEV_TRACE=true. */
  trace?: TurnTrace;
}

export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "tool"; name: string }
  | ({ type: "preview" } & PreviewState)
  | { type: "transcript"; text: string; language?: string; confidence?: number; duration_s?: number }
  | { type: "nudge"; text: string; count: number; max: number }
  | { type: "done"; reply: string; ui: unknown[]; tool_trace: { tool: string; ms: number }[]; domain: string; kind?: string; completion?: Completion; usage?: TurnUsage; trace?: TurnTrace }
  | { type: "error"; error: string; error_id?: string; degraded?: boolean };

export interface HistoryEntry {
  role: "user" | "assistant";
  text: string;
  ui: unknown[];
}
