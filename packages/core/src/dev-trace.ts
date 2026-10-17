/**
 * dev-trace.ts — what the playground's trace pane shows: one turn's route decision, step events,
 * tool calls with their arguments and result, and the model's timings, collected while it runs.
 *
 * What comes in:  hooks from the agent loop (tool calls, model calls) and the steps engine
 *                 (events), keyed by the Session object, and the gateway's route decision
 *                 (TurnOptions.route).
 * What goes out:  a TurnTrace on the reply and the `done` event (agent.ts), and a TurnRecord per
 *                 finished turn kept on the session (the last KEEP_TURNS) so GET /history can
 *                 replay them as `turns` (the gateway calls keepTurn).
 * Who talks to it: agent.ts, steps/engine.ts, the gateway's server.ts. Docs/CLIENT-PROTOCOL.md,
 *                 "The dev trace".
 *
 * Everything here is a no-op unless AGENT_DEV_TRACE is the literal "true": it is CONTENT (the
 * arguments a tool got, the text it returned), meant for the developer's own browser. It never
 * becomes a span attribute, a metric label or a behaviour event — telemetry keeps counts and enums.
 * Secrets and phone-like numbers are masked as in the log lines (logger.ts `redact`).
 */
import type { AgentReply, TurnLlm, TurnRecord, TurnRoute, TurnStep, TurnTool, TurnTrace } from "@marg-adk/types";
import { devTraceOn } from "./config.js";
import { redact, summarize } from "./logger.js";
import { saveSession, type Session } from "./session.js";

/** Turns kept on a session for the history replay; older ones fall off the front. */
export const KEEP_TURNS = 30;
const ARG_CHARS = 400;
const RESULT_CHARS = 2000;
const USER_CHARS = 300;

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}… (${s.length} chars)` : s);

/** The turn in flight per session. A session runs one turn at a time (the gateway's slot), and the
 *  WeakMap lets a turn that threw be collected with its session instead of leaking. */
const open = new WeakMap<Session, TurnTrace>();

/** Start collecting this turn's facts (no-op when the dev trace is off). */
export function beginTrace(session: Session, turn: number, route?: TurnRoute): void {
  if (!devTraceOn()) return;
  open.set(session, { turn, ...(route ? { route } : {}), steps: [], tools: [], llm: [] });
}

/** A step engine event (the same ones the `step` log line carries). */
export function traceStep(session: Session, step: string, event: TurnStep["event"], via?: string): void {
  open.get(session)?.steps.push({ step, event, ...(via ? { via } : {}) });
}

/** A tool call, with the arguments the tool received and the text it returned (masked, clipped). */
export function traceTool(session: Session, t: Omit<TurnTool, "args" | "result"> & { args: unknown; result: string }): void {
  open.get(session)?.tools.push({ ...t, args: summarize(t.args, ARG_CHARS), result: clip(redact(t.result), RESULT_CHARS) });
}

/** One model call: how long it took, what it cost in tokens, how it ended. */
export function traceLlm(session: Session, l: TurnLlm): void {
  open.get(session)?.llm.push(l);
}

/** Stop collecting and hand over what was collected (undefined when the dev trace is off). */
export function endTrace(session: Session): TurnTrace | undefined {
  const t = open.get(session);
  open.delete(session);
  return t;
}

/**
 * Keep a finished turn on the session for GET /history's `turns`. The gateway calls it after it has
 * metered the turn (it owns the elapsed time and the usage). No-op without a trace on the reply.
 */
export function keepTurn(session: Session, t: { user: string; display?: string; ms: number; out: Pick<AgentReply, "domain" | "kind" | "tool_trace" | "usage" | "completion" | "trace"> }): void {
  const { out } = t;
  if (!devTraceOn() || !out.trace) return;
  const rec: TurnRecord = {
    turn: out.trace.turn,
    user: clip(t.user, USER_CHARS),
    ...(t.display ? { display: clip(t.display, USER_CHARS) } : {}),
    ms: t.ms,
    domain: out.domain,
    ...(out.kind ? { kind: out.kind } : {}),
    tool_trace: out.tool_trace,
    ...(out.usage ? { usage: out.usage } : {}),
    ...(out.completion ? { completion: out.completion } : {}),
    trace: out.trace,
  };
  const turns = (session.turns ??= []);
  turns.push(rec);
  if (turns.length > KEEP_TURNS) turns.splice(0, turns.length - KEEP_TURNS);
  saveSession(session);
}
