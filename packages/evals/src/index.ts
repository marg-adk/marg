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

export interface TurnResult {
  user: string;
  reply: string;
  ui: any[];
  tool_trace: { tool: string; ms: number }[];
  kind?: string;
  error?: string;
  status?: number;
  ms: number;
  preview?: any;
  completion?: any;
  /** The last assistant entry of GET /history after this turn — what a reload would draw. */
  lastEntry?: { text: string; ui: any[] };
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
export interface Scenario {
  id: string;
  goal: string;
  /** The scenario ends in a real write: refused unless the gateway reports writes:false. */
  creates?: boolean;
  tags?: string[];
  turns: Turn[];
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
export const noUi = (type: string): Check => ({ name: `ui has no ${type}`, pass: (t) => !(t.ui ?? []).some((b) => b?.type === type) });
export const toolCalled = (name: string): Check => ({ name: `tool ${name} called (so far)`, pass: (_t, all) => all.some((x) => x.tool_trace?.some((tr) => tr.tool === name)) });
export const toolCalledThisTurn = (name: string): Check => ({ name: `tool ${name} called this turn`, pass: (t) => t.tool_trace?.some((tr) => tr.tool === name) });
export const neverTool = (name: string): Check => ({ name: `tool ${name} NEVER called`, pass: (_t, all) => !all.some((x) => x.tool_trace?.some((tr) => tr.tool === name)) });
export const neverToolThisTurn = (name: string): Check => ({ name: `tool ${name} NOT called this turn`, pass: (t) => !t.tool_trace?.some((tr) => tr.tool === name) });
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
  for (const turn of s.turns) {
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
          result = { user: message, reply: String(out.json.reply ?? ""), ui: out.json.ui ?? [], tool_trace: out.json.tool_trace ?? [], kind: out.json.kind, completion: out.json.completion, ms: Date.now() - tt0 };
          if (/briefly unavailable/i.test(result.reply)) transport = true;
        }
      } catch (e) {
        result = { user: message, reply: "", ui: [], tool_trace: [], ms: Date.now() - tt0, error: String(e) };
        transport = true;
      }
      try {
        const h = await api(o.gateway, `/api/session/${encodeURIComponent(session_id)}/history`, undefined, headers, s.id);
        result.preview = h.json?.preview ?? null;
        const entries = h.json?.entries ?? [];
        const lastA = [...entries].reverse().find((e: any) => e.role === "assistant");
        if (lastA) result.lastEntry = { text: lastA.text, ui: lastA.ui ?? [] };
      } catch {
        /* history fetch failed — checks that need it fail on their own */
      }
    }
    (result as TurnResult & { actResult?: unknown }).actResult = actResult;
    all.push(result);
    for (const c of turn.checks ?? []) (c.pass(result, all) ? passed : failed).push(`[${s.id}] t${all.length} ${c.name}`);
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
