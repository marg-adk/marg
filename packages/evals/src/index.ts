/**
 * @marg-adk/evals — evals are the ratchet.
 *
 * A scenario is a scripted multi-turn conversation replayed against a gateway started with
 * WRITES OFF, with deterministic checks per turn (reply regexes, ui block types, tools called or
 * never called, the draft's state) and final checks over the whole conversation. The exit code
 * is the CI gate. Model wording varies run to run, so checks assert what must ALWAYS hold.
 *
 * STANDING RULES (docs/PLAYBOOK.md):
 *  - Run before AND after any skill change or refactor.
 *  - A red is classified before it is fixed: check brittleness (fix the CHECK), a model flake
 *    (green on a serial rerun — record it in the flake ledger), a real regression (fix the agent),
 *    or pre-existing (red on a clean baseline too). The suite is trustworthy because the
 *    distinction is kept honest.
 *  - Shard for speed: EVAL_SHARD=i/n splits the scenario list; run one gateway per shard. Keep the
 *    shard count under your provider's rate limit (3 was the sweet spot with a real model).
 *  - A scenario that would end in a real write is REFUSED unless the gateway's health says
 *    writes are off.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * One turn's dev trace, as a gateway started with AGENT_DEV_TRACE=true sends it (docs/CLIENT-PROTOCOL.md,
 * "The dev trace"): the route decision, the step engine's events, every tool call with its arguments
 * and result, the model's calls. Only the fields the checks use are typed.
 */
export interface DevTrace {
  turn: number;
  route?: { domain: string; by: string; confidence?: number };
  steps: { step: string; event: string; via?: string }[];
  tools: { name: string; args: any; result: string; ms: number; ok?: boolean; carried?: string[]; refused?: string; runtime?: boolean }[];
  llm: { round: number; endpoint?: string; model?: string; ms: number; ttft_ms?: number; input: number; output: number; finish: string }[];
}

export interface TurnResult {
  user: string;
  reply: string;
  ui: any[];
  tool_trace: { tool: string; ms: number }[];
  kind?: string;
  /** The domain that answered (the super agent's pick), from the chat response. */
  domain?: string;
  error?: string;
  status?: number;
  ms: number;
  preview?: any;
  completion?: any;
  /** The last assistant entry of GET /history after this turn — what a reload would draw. */
  lastEntry?: { text: string; ui: any[] };
  /** This turn's dev trace (absent when the gateway runs with AGENT_DEV_TRACE off). */
  trace?: DevTrace;
  /** GET /history's `turns` after this turn — what a reload would redraw in a trace pane. */
  turns?: { turn: number; trace: DevTrace; [k: string]: any }[];
}

export type Check = { name: string; pass: (turn: TurnResult, all: TurnResult[]) => boolean };
export type Turn = {
  /** The message, or a function of the turns so far (a form submit built from the form on screen). */
  send?: string | ((all: TurnResult[]) => string);
  /** What the user's bubble shows (a form echo). */
  display?: string;
  /** An HTTP step before the message (an upload, a PATCH) — its result lands on the turn as `actResult`. */
  act?: (ctx: { session_id: string; gateway: string; all: TurnResult[] }) => Promise<unknown>;
  checks?: Check[];
};
/** What a simulated user sees before choosing its next message. */
export interface SimView {
  /** 0 before the first message. */
  turn: number;
  last?: TurnResult;
  all: TurnResult[];
  /** The blocks on screen: what the last turn drew, or what a reload would redraw. */
  ui: any[];
  draft: any;
  completed: boolean;
}
/**
 * A simulated user: scripted (a persona that reacts to what is on screen) or model-played (a
 * function that asks any model for the next message). It returns the next turn, a bare message,
 * or null when it is done; `max` bounds the conversation (default 12).
 */
export interface UserSim {
  next(view: SimView): Promise<Turn | string | null> | Turn | string | null;
  max?: number;
}
export interface Scenario {
  id: string;
  goal: string;
  /** The scenario ends in a real write: refused unless the gateway reports writes:false. */
  creates?: boolean;
  tags?: string[];
  /** Scripted turns — or leave empty and set `user`. */
  turns: Turn[];
  /** A simulated user generates the turns instead of `turns`. */
  user?: UserSim;
  /** Checks applied to every turn (the invariants: no error, one question, no leak…). */
  everyTurn?: Check[];
  finalChecks?: Check[];
}

// ---- check combinators ------------------------------------------------------------------
export const noError: Check = { name: "no error", pass: (t) => !t.error };
export const replyMatches = (re: RegExp): Check => ({ name: `reply ~ ${re}`, pass: (t) => re.test(t.reply) });
export const replyNotMatches = (re: RegExp): Check => ({ name: `reply !~ ${re}`, pass: (t) => !re.test(t.reply) });
export const replyOrUiMatches = (re: RegExp): Check => ({ name: `reply|ui ~ ${re}`, pass: (t) => re.test(t.reply) || re.test(JSON.stringify(t.ui ?? [])) });
export const hasUi = (type?: string, tag?: Record<string, unknown>): Check => ({
  name: `ui has ${type ?? "a block"}${tag ? " " + JSON.stringify(tag) : ""}`,
  pass: (t) => (t.ui ?? []).some((b) => (!type || b?.type === type) && (!tag || Object.entries(tag).every(([k, v]) => b?.[k] === v))),
});
/** A form block on this turn has row `key` with a value / an error matching (a partial submit comes back pre-filled and marked). */
export const formRow = (key: string, want: { value?: RegExp; error?: RegExp }): Check => ({
  name: `form row ${key}${want.value ? ` value ~ ${want.value}` : ""}${want.error ? ` error ~ ${want.error}` : ""}`,
  pass: (t) =>
    (t.ui ?? []).some(
      (b) => b?.type === "form" && (Array.isArray(b.rows) ? b.rows : []).some((r: any) => r?.key === key && (!want.value || want.value.test(String(r.value ?? ""))) && (!want.error || want.error.test(String(r.error ?? "")))),
    ),
});
export const noUi = (type: string): Check => ({ name: `ui has no ${type}`, pass: (t) => !(t.ui ?? []).some((b) => b?.type === type) });
export const toolCalled = (name: string): Check => ({ name: `tool ${name} called (so far)`, pass: (_t, all) => all.some((x) => x.tool_trace?.some((tr) => tr.tool === name)) });
export const toolCalledThisTurn = (name: string): Check => ({ name: `tool ${name} called this turn`, pass: (t) => t.tool_trace?.some((tr) => tr.tool === name) });
export const neverTool = (name: string): Check => ({ name: `tool ${name} NEVER called`, pass: (_t, all) => !all.some((x) => x.tool_trace?.some((tr) => tr.tool === name)) });
export const neverToolThisTurn = (name: string): Check => ({ name: `tool ${name} NOT called this turn`, pass: (t) => !t.tool_trace?.some((tr) => tr.tool === name) });
/** The super agent routed this turn to `name` (a two-domain gateway). */
export const inDomain = (name: string): Check => ({ name: `routed to ${name}`, pass: (t) => t.domain === name });
export const runtimeTurn = (kind?: string): Check => ({ name: `answered by the runtime${kind ? ` (${kind})` : ""}`, pass: (t) => Boolean(t.kind) && (!kind || t.kind === kind) });
export const modelTurn: Check = { name: "answered by the model", pass: (t) => !t.kind };
export const draftHas = (slot: string, re?: RegExp): Check => ({
  name: `draft has ${slot}${re ? ` ~ ${re}` : ""}`,
  pass: (t) => {
    const v = t.preview?.slots?.[slot];
    return v !== undefined && (!re || re.test(String(v)));
  },
});
export const draftState = (state: string): Check => ({ name: `draft state ${state}`, pass: (t) => t.preview?.state === state });
export const stepStatus = (key: string, status: string): Check => ({ name: `step ${key} is ${status}`, pass: (t) => t.preview?.steps?.[key]?.status === status });
export const completed: Check = { name: "completed", pass: (t) => Boolean(t.completion?.entity_id) };
export const notCompleted: Check = { name: "not completed", pass: (t) => !t.completion };
export const reloadRedraws = (type: string): Check => ({ name: `reload redraws ${type}`, pass: (t) => (t.lastEntry?.ui ?? []).some((b) => b?.type === type) });

// ---- the dev trace (the gateway must run with AGENT_DEV_TRACE=true — `npm run gateway:evals` does) ----
const argMatches = (got: unknown, want: string | RegExp): boolean => (want instanceof RegExp ? want.test(String(got ?? "")) : String(got ?? "") === want);
export const hasTrace: Check = { name: "dev trace present (the eval gateway needs AGENT_DEV_TRACE=true)", pass: (t) => Boolean(t.trace) };
/** The route decision of this turn: the domain, the deciding link, and (with `confidence: true`) a typed decision's confidence in (0, 1]. */
export const routeIs = (want: { domain?: string; by?: string; confidence?: boolean }): Check => ({
  name: `route ${JSON.stringify(want)}`,
  pass: (t) => {
    const r = t.trace?.route;
    return Boolean(r) && (!want.domain || r!.domain === want.domain) && (!want.by || r!.by === want.by) && (!want.confidence || (typeof r!.confidence === "number" && r!.confidence > 0 && r!.confidence <= 1));
  },
});
/** The step engine's event for `step` this turn (drawn, late_draw, redrawn, reopened, settled, skipped, summary). */
export const stepEvent = (step: string, event: string): Check => ({ name: `step ${step} ${event} this turn`, pass: (t) => Boolean(t.trace?.steps.some((s) => s.step === step && s.event === event)) });
/** A call to `tool` this turn whose arguments match (strings exactly, regexes by test) and, optionally, whose result matches. */
export const toolCall = (tool: string, want: { args?: Record<string, string | RegExp>; result?: RegExp } = {}): Check => ({
  name: `trace: ${tool} called${want.args ? " with " + JSON.stringify(want.args, (_k, v) => (v instanceof RegExp ? String(v) : v)) : ""}${want.result ? ` → ${want.result}` : ""}`,
  pass: (t) => Boolean(t.trace?.tools.some((c) => c.name === tool && Object.entries(want.args ?? {}).every(([k, v]) => argMatches(c.args?.[k], v)) && (!want.result || want.result.test(c.result)))),
});
/** A reload shows what was live: GET /history's `turns` holds this turn's trace unchanged. */
export const reloadKeepsTrace: Check = {
  name: "reload keeps this turn's trace (history turns)",
  pass: (t) => Boolean(t.trace) && (t.turns ?? []).some((x) => x.turn === t.trace!.turn && JSON.stringify(x.trace) === JSON.stringify(t.trace)),
};
export const oneQuestion: Check = { name: "at most one question", pass: (t) => (t.reply.match(/\?/g) ?? []).length <= 1 };
export const noLeak = (re: RegExp): Check => ({ name: `no leak ${re}`, pass: (t) => !re.test(t.reply) && !re.test(JSON.stringify(t.ui ?? [])) });

/** Build a form submit from the form the previous turn drew: `over` sets values by row key (null = leave empty). */
export function submitForm(over: Record<string, string | null> = {}): (all: TurnResult[]) => string {
  return (all) => {
    const last = all[all.length - 1];
    const form = [...(last?.lastEntry?.ui ?? last?.ui ?? [])].reverse().find((b) => b?.type === "form");
    if (!form) throw new Error("submitForm: no form on screen");
    const parts: string[] = [];
    for (const r of form.rows ?? []) {
      const v = over[r.key] === undefined ? r.value : over[r.key];
      if (v) parts.push(`${r.label} [${r.key}]: ${String(v).replace(/;/g, ",")}`);
    }
    return parts.join("; ");
  };
}

/** Tap a chip of the last turn by label (or value). */
export function tap(label: string): (all: TurnResult[]) => string {
  return (all) => {
    const last = all[all.length - 1];
    for (const b of last?.ui ?? []) {
      for (const o of b?.options ?? []) if (o.label === label || o.value === label) return String(o.value ?? o.label);
      for (const a of b?.actions ?? []) if (a.label === label || a.value === label) return String(a.value ?? a.label);
      for (const it of b?.items ?? []) if (it.title === label || it.value === label) return String(it.value ?? it.title);
    }
    throw new Error(`tap: no option "${label}" on screen (have: ${JSON.stringify((last?.ui ?? []).map((b: any) => (b.options ?? b.actions ?? b.items ?? []).map((o: any) => o.label ?? o.title)))})`);
  };
}

// ---- simulated users ----------------------------------------------------------------------
export interface CooperativeUserOptions {
  /** The first message. */
  opener: string;
  /** Form rows by key → the value to type; a required row with no answer is left empty (the runtime redraws it). */
  answers?: Record<string, string>;
  /** Labels to tap when offered (chips, list items, card actions), in order of preference; else the first option. */
  prefer?: string[];
  /** Free text to say instead of answering, once, after the given turn count (a question beside an open ask, a digression). */
  asides?: { after: number; say: string }[];
  /** Done when the job completed, or a create was refused because writes are off (the evals gateway). Override to end elsewhere. */
  done?: (view: SimView) => boolean;
  max?: number;
}
const refusedWrite = (t?: TurnResult): boolean => Boolean(t && /writes are disabled/i.test(t.reply));
/**
 * A persona that cooperates: opens with one sentence, fills the cards it is shown from `answers`,
 * taps what it prefers among what is offered, confirms the summary, and says its asides at the
 * turns you set. Deterministic, so a scenario with it runs in CI on the mock model; the checks
 * stay the same deterministic checks. A model-played user is the same `UserSim` shape with
 * `next` asking a model — write one where free text beyond a script matters, outside CI.
 */
export function cooperativeUser(o: CooperativeUserOptions): UserSim {
  const said = new Set<number>();
  const prefer = o.prefer ?? [];
  const pick = (options: { label: string; value?: string }[]): string | undefined => {
    const live = options.filter((x) => x && !(x as any).off && !(x as any).ghost);
    for (const p of prefer) { const hit = live.find((x) => x.label === p || x.value === p); if (hit) return String(hit.value ?? hit.label); }
    return live[0] ? String(live[0].value ?? live[0].label) : undefined;
  };
  return {
    max: o.max,
    next(view) {
      if (view.turn === 0) return o.opener;
      if (o.done ? o.done(view) : view.completed || refusedWrite(view.last)) return null;
      const aside = (o.asides ?? []).find((a) => a.after === view.turn && !said.has(a.after));
      if (aside) { said.add(aside.after); return aside.say; }
      for (const b of [...view.ui].reverse()) {
        if (b?.type === "form" && Array.isArray(b.rows)) {
          const parts: string[] = [];
          for (const r of b.rows) {
            const v = o.answers?.[r.key] ?? r.value;
            if (v) parts.push(`${r.label} [${r.key}]: ${String(v).replace(/;/g, ",")}`);
          }
          if (parts.length) return parts.join("; ");
        }
        if (b?.type === "card" && Array.isArray(b.actions) && b.actions.length) {
          const confirm = b.actions.find((a: any) => /^confirm/i.test(String(a.label ?? "")));
          const chosen = confirm ? String(confirm.value ?? confirm.label) : pick(b.actions);
          if (chosen) return chosen;
        }
        if ((b?.type === "chips" || b?.type === "multichips") && Array.isArray(b.options)) { const v = pick(b.options); if (v) return v; }
        if (b?.type === "list" && Array.isArray(b.items)) { const v = pick(b.items.map((it: any) => ({ label: it.title, value: it.value ?? it.title }))); if (v) return v; }
      }
      return null; // nothing to answer: the user has nothing more to say
    },
  };
}

// ---- the runner ---------------------------------------------------------------------------
export interface RunOptions {
  gateway: string;
  scenarios: Scenario[];
  only?: string[];
  /** "i/n": run the i-th of n round-robin shards (0-based). */
  shard?: string;
  resultsDir: string;
  headers?: Record<string, string>;
  /** Scenarios known to flake (green on rerun); a red there is reported as FLAKE, not FAIL. */
  flakeLedger?: string[];
  /** Rerun a red scenario this many times before calling it a failure (default 0). */
  reruns?: number;
  verbose?: boolean;
}

export interface ScenarioRun {
  id: string;
  goal: string;
  ok: boolean;
  passed: string[];
  failed: string[];
  turns: TurnResult[];
  secs: number;
  classification?: "pass" | "flake" | "fail" | "transport";
  attempts: number;
}

async function api(gateway: string, path: string, body: unknown, headers: Record<string, string>, scenario: string): Promise<{ status: number; json: any }> {
  const res = await fetch(gateway + path, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", "X-Agent-Eval": scenario, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

export async function runScenario(s: Scenario, o: RunOptions): Promise<ScenarioRun> {
  const t0 = Date.now();
  const headers = o.headers ?? {};
  const sess = await api(o.gateway, "/api/session", {}, headers, s.id);
  if (sess.status !== 200) throw new Error(`session create failed: ${sess.status} ${JSON.stringify(sess.json).slice(0, 200)}`);
  const session_id = sess.json.session_id as string;
  const all: TurnResult[] = [];
  const passed: string[] = [];
  const failed: string[] = [];
  let transport = false;
  const viewOf = (): SimView => {
    const last = all[all.length - 1];
    return { turn: all.length, last, all, ui: last ? (last.lastEntry?.ui?.length ? last.lastEntry.ui : last.ui) : [], draft: last?.preview ?? null, completed: Boolean(last?.completion) };
  };
  let scripted = 0;
  for (;;) {
    let turn: Turn | undefined;
    if (s.user) {
      if (all.length >= (s.user.max ?? 12)) { failed.push(`[${s.id}] the simulated user did not finish within ${s.user.max ?? 12} turns`); break; }
      let nextTurn: Turn | string | null;
      try {
        nextTurn = await s.user.next(viewOf());
      } catch (e) {
        failed.push(`[${s.id}] t${all.length + 1} user: ${(e as Error).message}`);
        break;
      }
      if (nextTurn === null) break;
      turn = typeof nextTurn === "string" ? { send: nextTurn } : nextTurn;
    } else {
      turn = s.turns[scripted++];
      if (!turn) break;
    }
    const tt0 = Date.now();
    let actResult: unknown;
    if (turn.act) actResult = await turn.act({ session_id, gateway: o.gateway, all });
    let message: string | undefined;
    try {
      message = typeof turn.send === "function" ? turn.send(all) : turn.send;
    } catch (e) {
      const r: TurnResult = { user: "(send)", reply: "", ui: [], tool_trace: [], ms: 0, error: String((e as Error).message) };
      all.push(r);
      failed.push(`[${s.id}] t${all.length} ${(e as Error).message}`);
      break;
    }
    let result: TurnResult;
    if (message === undefined) {
      result = { user: "(act)", reply: "", ui: [], tool_trace: [], ms: Date.now() - tt0 };
    } else {
      try {
        const out = await api(o.gateway, "/api/chat", { session_id, message, display: turn.display }, headers, s.id);
        if (out.status !== 200) {
          result = { user: message, reply: "", ui: [], tool_trace: [], ms: Date.now() - tt0, error: `${out.status}: ${out.json?.error ?? ""}`, status: out.status };
          if (out.status >= 500 || out.status === 429) transport = true;
        } else {
          result = { user: message, reply: String(out.json.reply ?? ""), ui: out.json.ui ?? [], tool_trace: out.json.tool_trace ?? [], kind: out.json.kind, domain: out.json.domain, completion: out.json.completion, trace: out.json.trace, ms: Date.now() - tt0 };
          if (/briefly unavailable/i.test(result.reply)) transport = true;
        }
      } catch (e) {
        result = { user: message, reply: "", ui: [], tool_trace: [], ms: Date.now() - tt0, error: String(e) };
        transport = true;
      }
      try {
        const h = await api(o.gateway, `/api/session/${encodeURIComponent(session_id)}/history`, undefined, headers, s.id);
        result.preview = h.json?.preview ?? null;
        if (Array.isArray(h.json?.turns)) result.turns = h.json.turns;
        const entries = h.json?.entries ?? [];
        const lastA = [...entries].reverse().find((e: any) => e.role === "assistant");
        if (lastA) result.lastEntry = { text: lastA.text, ui: lastA.ui ?? [] };
      } catch {
        /* history fetch failed — checks that need it fail on their own */
      }
    }
    (result as TurnResult & { actResult?: unknown }).actResult = actResult;
    all.push(result);
    for (const c of [...(s.everyTurn ?? []), ...(turn.checks ?? [])]) (c.pass(result, all) ? passed : failed).push(`[${s.id}] t${all.length} ${c.name}`);
    if (o.verbose) console.log(`   t${all.length} ${message === undefined ? "(act)" : JSON.stringify(message).slice(0, 80)} → ${result.kind ? `[${result.kind}] ` : ""}${result.reply.slice(0, 120).replace(/\n/g, " ")} ${result.ui.length ? "ui:" + result.ui.map((b) => b.type).join(",") : ""}`);
  }
  for (const c of s.finalChecks ?? []) (c.pass(all[all.length - 1], all) ? passed : failed).push(`[${s.id}] final ${c.name}`);
  const ok = failed.length === 0;
  return { id: s.id, goal: s.goal, ok, passed, failed, turns: all, secs: Math.round((Date.now() - t0) / 1000), classification: ok ? "pass" : transport ? "transport" : undefined, attempts: 1 };
}

export function selectScenarios(scenarios: Scenario[], o: Pick<RunOptions, "only" | "shard">): Scenario[] {
  let selected = o.only?.length ? scenarios.filter((s) => o.only!.includes(s.id) || s.tags?.some((t) => o.only!.includes(t))) : scenarios;
  if (o.shard) {
    const m = /^(\d+)\/(\d+)$/.exec(o.shard);
    if (!m) throw new Error(`EVAL_SHARD must be i/n, got ${o.shard}`);
    const [i, n] = [Number(m[1]), Number(m[2])];
    selected = selected.filter((_, idx) => idx % n === i);
  }
  return selected;
}

/** Run the suite: writes transcripts + _summary.json, prints the gate report, returns whether every scenario passed (after reruns and flake classification). */
export async function runSuite(o: RunOptions): Promise<{ ok: boolean; runs: ScenarioRun[] }> {
  const health = await fetch(o.gateway + "/api/health").then((r) => r.json()).catch(() => null) as { writes?: boolean; llm?: { model?: string }; domains?: { name: string; tools?: number }[] } | null;
  if (!health) throw new Error(`gateway not reachable at ${o.gateway} — start it with writes off first (npm run gateway:evals)`);
  console.log(`Eval target: ${o.gateway} | model: ${health.llm?.model} | writes: ${health.writes} | domains: ${(health.domains ?? []).map((d) => `${d.name}(${d.tools})`).join(",")}`);
  const selected = selectScenarios(o.scenarios, o);
  mkdirSync(o.resultsDir, { recursive: true });
  const runs: ScenarioRun[] = [];
  for (const s of selected) {
    if (s.creates && health.writes !== false) {
      console.log(`SKIP  ${s.id} — ends in a write; the gateway reports writes:${health.writes}`);
      continue;
    }
    console.log(`▶ ${s.id} — ${s.goal}`);
    let run = await runScenario(s, o);
    for (let r = 0; !run.ok && r < (o.reruns ?? 0); r++) {
      console.log(`   ↻ rerun ${r + 1}`);
      const again = await runScenario(s, o);
      again.attempts = r + 2;
      if (again.ok) {
        again.classification = "flake";
        run = again;
        break;
      }
      run = again;
    }
    if (!run.ok && !run.classification) run.classification = o.flakeLedger?.includes(s.id) ? "flake" : "fail";
    runs.push(run);
    writeFileSync(join(o.resultsDir, `${s.id}.json`), JSON.stringify(run, null, 2));
    const tag = run.ok ? "✅ PASS" : run.classification === "flake" ? "🟡 FLAKE" : run.classification === "transport" ? "🟠 TRANSPORT" : "❌ FAIL";
    console.log(`${tag}  ${s.id} (${run.secs}s${run.attempts > 1 ? `, ${run.attempts} attempts` : ""})${run.failed.length ? "\n      " + run.failed.join("\n      ") : ""}`);
  }
  const summary = runs.map((r) => ({ id: r.id, goal: r.goal, ok: r.ok, classification: r.classification, failed: r.failed, secs: r.secs, attempts: r.attempts }));
  writeFileSync(join(o.resultsDir, "_summary.json"), JSON.stringify({ gateway: o.gateway, model: health.llm?.model, ran_at: new Date().toISOString(), shard: o.shard ?? null, summary }, null, 2));
  const pass = runs.filter((r) => r.ok).length;
  const flakes = runs.filter((r) => !r.ok && r.classification === "flake").length;
  const transport = runs.filter((r) => !r.ok && r.classification === "transport").length;
  const fails = runs.length - pass - flakes - transport;
  console.log(`\nGATE: ${pass}/${runs.length} pass · ${flakes} flake · ${transport} transport · ${fails} fail — results: ${o.resultsDir}`);
  return { ok: fails === 0 && transport === 0, runs };
}
