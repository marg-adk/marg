/**
 * usage-caps.ts — token budgets (usage caps) and per-turn metering.
 *
 * Caps count PLAN TOKENS (session.ts: a cost-weighted token count) per subject — the verified
 * user when known, else the session — in fixed windows that start at first use (5h / day /
 * week) or a calendar month, plus a per-session lifetime cap and a context cap. All OFF unless
 * set (values in plan tokens; 0/unset = off):
 *
 *   AGENT_CAP_TOKENS_PER_SESSION  AGENT_CAP_TOKENS_5H  AGENT_CAP_TOKENS_DAY  AGENT_CAP_TOKENS_WEEK
 *   AGENT_CAP_TOKENS_MONTH (calendar month, AGENT_CAP_TZ_OFFSET_MIN for the month boundary)
 *   AGENT_CAP_CONTEXT_TOKENS (max prompt size → "start a new chat")
 *
 * Users see a PERCENTAGE of their cap, never tokens. Every turn is also appended to the durable
 * usage ledger with its vendor cost — bill what vendors bill you (docs/METERING.md).
 */
import { createHash } from "node:crypto";
import type express from "express";
import type { CapStanding, TurnUsage } from "@marg/types";
import { envNum0, getCounterStore, log, planTokens, recordCapped, recordUsageEvent, sessionPlanTokens, sessionTotalTokens, type Session } from "@marg/core";
import { meteringSink } from "./metering-sink.js";

export const capConfig = {
  perSession: envNum0("AGENT_CAP_TOKENS_PER_SESSION", 0),
  contextTokens: envNum0("AGENT_CAP_CONTEXT_TOKENS", 0),
  month: envNum0("AGENT_CAP_TOKENS_MONTH", 0),
  tzOffsetMin: Number(process.env.AGENT_CAP_TZ_OFFSET_MIN ?? 0) || 0,
  windows: [
    { scope: "5h", limit: envNum0("AGENT_CAP_TOKENS_5H", 0), ms: 5 * 3600_000 },
    { scope: "day", limit: envNum0("AGENT_CAP_TOKENS_DAY", 0), ms: 24 * 3600_000 },
    { scope: "week", limit: envNum0("AGENT_CAP_TOKENS_WEEK", 0), ms: 7 * 24 * 3600_000 },
  ].filter((w) => w.limit > 0),
};

/** Cap subject: the verified user (hash of the id, never the raw token), else the session. */
export function capSubject(session: Session): string {
  if (session.userId) return "u:" + createHash("sha256").update(session.userId).digest("hex").slice(0, 16);
  if (session.authToken) return "t:" + createHash("sha256").update(session.authToken).digest("hex").slice(0, 16);
  return "session:" + session.id;
}

function monthWindow(): { key: string; msToReset: number } {
  const now = new Date(Date.now() + capConfig.tzOffsetMin * 60_000);
  const key = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) - capConfig.tzOffsetMin * 60_000;
  return { key, msToReset: Math.max(1000, next - Date.now()) };
}

const pct = (used: number, limit: number): number => Math.max(0, Math.min(100, Math.round((used / limit) * 100)));

function fmtReset(s: number): string {
  if (s >= 2 * 86400) return `${Math.round(s / 86400)} days`;
  if (s >= 5400) return `${Math.round(s / 3600)}h`;
  return `${Math.max(1, Math.round(s / 60))}min`;
}

export async function capStatuses(session: Session): Promise<CapStanding[]> {
  const out: CapStanding[] = [];
  const planUsed = sessionPlanTokens(session);
  if (capConfig.perSession) out.push({ scope: "session", limit_tokens: capConfig.perSession, used_tokens: planUsed, remaining_tokens: Math.max(0, capConfig.perSession - planUsed), resets_in_s: null, percent: pct(planUsed, capConfig.perSession) });
  const subject = capSubject(session);
  const peek = async (key: string, ms: number) => {
    try {
      return await getCounterStore().peek(key, ms);
    } catch (e) {
      log.warn("usage-cap counter unavailable — treating as unused (fail-open)", { key, error: (e as Error).message });
      return { count: 0, ms_to_reset: ms };
    }
  };
  for (const w of capConfig.windows) {
    const c = await peek(`cap:${w.scope}:${subject}`, w.ms);
    out.push({ scope: w.scope, limit_tokens: w.limit, used_tokens: c.count, remaining_tokens: Math.max(0, w.limit - c.count), resets_in_s: c.count > 0 ? Math.ceil(c.ms_to_reset / 1000) : null, percent: pct(c.count, w.limit) });
  }
  if (capConfig.month) {
    const m = monthWindow();
    const c = await peek(`cap:month:${m.key}:${subject}`, m.msToReset);
    out.push({ scope: "month", limit_tokens: capConfig.month, used_tokens: c.count, remaining_tokens: Math.max(0, capConfig.month - c.count), resets_in_s: Math.ceil(m.msToReset / 1000), percent: pct(c.count, capConfig.month) });
  }
  return out;
}

/** Gate a chat turn against the caps. Sends the 429 itself and returns false if any cap is exhausted. */
export async function allowTurn(session: Session, res: express.Response): Promise<boolean> {
  if (capConfig.contextTokens && (session.lastContextTokens ?? 0) >= capConfig.contextTokens) {
    recordCapped("context");
    log.warn("usage capped", { scope: "context", session: session.id, context_tokens: session.lastContextTokens });
    res.status(429).json({ error: "This conversation has reached its context limit — please start a new chat to continue.", code: "usage_cap", scope: "context" });
    return false;
  }
  for (const cap of await capStatuses(session)) {
    if (cap.used_tokens >= cap.limit_tokens) {
      recordCapped(cap.scope);
      log.warn("usage capped", { scope: cap.scope, subject: capSubject(session), percent: cap.percent });
      const when = cap.resets_in_s ? ` It resets in ${fmtReset(cap.resets_in_s)}.` : " Please start a new chat.";
      if (cap.resets_in_s) res.setHeader("Retry-After", String(cap.resets_in_s));
      res.status(429).json({ error: `You've reached your ${cap.scope === "session" ? "per-chat" : cap.scope} usage limit.${when}`, code: "usage_cap", scope: cap.scope, percent: cap.percent, resets_in_s: cap.resets_in_s });
      return false;
    }
  }
  return true;
}

/** Meter a finished turn: add its plan tokens to every cap window, append the usage ledger event, hand the vendor cost to the metering sink. */
export async function commitTurnUsage(session: Session, before: Session["usage"], meta: { domain: string; ms: number; tool_calls: number; runtime?: boolean }): Promise<{ turn_tokens: number; turn_plan: number }> {
  const turn = {
    input: session.usage.input - before.input,
    output: session.usage.output - before.output,
    cache_read: session.usage.cache_read - before.cache_read,
    cache_write: session.usage.cache_write - before.cache_write,
  };
  const total = turn.input + turn.output + turn.cache_read + turn.cache_write;
  const plan = planTokens(turn);
  const cost = (session.usage.cost_usd ?? 0) - (before.cost_usd ?? 0);
  const subject = capSubject(session);
  const add = async (key: string, ms: number) => {
    try {
      await getCounterStore().incr(key, ms, plan);
    } catch (e) {
      log.warn("usage-cap meter write failed (fail-open)", { key, error: (e as Error).message });
    }
  };
  if (plan > 0) {
    for (const w of capConfig.windows) await add(`cap:${w.scope}:${subject}`, w.ms);
    if (capConfig.month) {
      const m = monthWindow();
      await add(`cap:month:${m.key}:${subject}`, m.msToReset);
    }
  }
  recordUsageEvent({ ts: Date.now(), session_id: session.id, subject, domain: meta.domain, tokens: turn, total_tokens: total, plan_tokens: plan, cost_usd: +cost.toFixed(6), provider: session.usage.provider, model: session.usage.model, ms: meta.ms, tool_calls: meta.tool_calls, runtime: meta.runtime });
  meteringSink.turn({ account_id: subject, session_id: session.id, turn: session.turn ?? 0, domain: meta.domain, tokens: turn, cost_usd: cost, provider: session.usage.provider, model: session.usage.model, runtime: Boolean(meta.runtime) });
  return { turn_tokens: total, turn_plan: plan };
}

export async function meterTurn(session: Session, before: Session["usage"], meta: { domain: string; ms: number; tool_calls: number; runtime?: boolean }): Promise<TurnUsage> {
  const { turn_tokens, turn_plan } = await commitTurnUsage(session, before, meta);
  return { turn_tokens, session_tokens: sessionTotalTokens(session), turn_plan, session_plan: sessionPlanTokens(session), caps: await capStatuses(session) };
}

export function capSnapshot() {
  return {
    per_session_tokens: capConfig.perSession || null,
    context_tokens: capConfig.contextTokens || null,
    month_tokens: capConfig.month || null,
    windows: capConfig.windows.map((w) => ({ scope: w.scope, limit_tokens: w.limit })),
    unit: "plan tokens (cost-weighted; users see a percentage)",
  };
}
