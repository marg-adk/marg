/**
 * rate-limit.ts — request rate limiting and concurrency throttling.
 *
 * WINDOW LIMITS ("no more than N per minute") are counted in the shared CounterStore — with
 * Redis configured the counts are correct across gateway nodes. CONCURRENCY GUARDS ("no more
 * than N turns running right now") are process-local on purpose: they protect this node's work.
 *
 *  - session creation per IP      AGENT_RATE_SESSIONS_PER_IP   (20/min)
 *  - chat turns per session       AGENT_RATE_CHAT_PER_SESSION  (10/min)
 *  - chat turns per IP            AGENT_RATE_CHAT_PER_IP       (60/min)
 *  - one in-flight turn per session (overlap would interleave history) + a global cap
 *    AGENT_RATE_MAX_CONCURRENT (8). AGENT_RATE_DISABLED=true switches the window limits off.
 *
 * Runtime-answered turns (a chip tap read in code, no model call) are REFUNDED against the
 * per-session limit: a user tapping through five cards in a minute is the product working, not
 * abuse (a production chat hit the limit on its 11th tap).
 */
import type express from "express";
import { envNum, getCounterStore, log, recordRateLimited } from "@marg/core";

const WINDOW_MS = 60_000;

export const rateConfig = {
  disabled: process.env.AGENT_RATE_DISABLED === "true",
  sessionsPerIp: envNum("AGENT_RATE_SESSIONS_PER_IP", 20),
  chatPerSession: envNum("AGENT_RATE_CHAT_PER_SESSION", 10),
  chatPerIp: envNum("AGENT_RATE_CHAT_PER_IP", 60),
  transcribePerIp: envNum("AGENT_RATE_TRANSCRIBE_PER_IP", 30),
  mediaPerIp: envNum("AGENT_RATE_MEDIA_PER_IP", 60),
  maxConcurrent: envNum("AGENT_RATE_MAX_CONCURRENT", 8),
};

async function take(key: string, limit: number): Promise<number> {
  try {
    const w = await getCounterStore().incr(`rate:${key}`, WINDOW_MS);
    return w.count > limit ? Math.max(1, Math.ceil(w.ms_to_reset / 1000)) : 0;
  } catch (e) {
    // Counter store unreachable mid-flight — FAIL OPEN; the in-flight guards still bound load.
    log.warn("rate-limit counter unavailable — allowing (fail-open)", { key, error: (e as Error).message });
    return 0;
  }
}

const inFlightSessions = new Set<string>();
let inFlightTotal = 0;

function reject(res: express.Response, scope: string, retryAfterS: number, key: string): void {
  recordRateLimited(scope);
  log.warn("rate limited", { scope, key, retry_after_s: retryAfterS });
  res.setHeader("Retry-After", String(retryAfterS));
  res.status(429).json({ error: `Rate limit exceeded (${scope}). Retry in ${retryAfterS}s.`, retry_after_s: retryAfterS, code: "rate_limit" });
}

export function clientIp(req: express.Request): string {
  return req.ip ?? "unknown";
}

export async function allowSessionCreate(req: express.Request, res: express.Response): Promise<boolean> {
  if (rateConfig.disabled) return true;
  const ip = clientIp(req);
  const wait = await take(`sess-create:${ip}`, rateConfig.sessionsPerIp);
  if (wait) {
    reject(res, "session creation per IP", wait, ip);
    return false;
  }
  return true;
}

export async function allowTranscribe(req: express.Request, res: express.Response): Promise<boolean> {
  if (rateConfig.disabled) return true;
  const ip = clientIp(req);
  const wait = await take(`transcribe:${ip}`, rateConfig.transcribePerIp);
  if (wait) {
    reject(res, "voice notes per IP", wait, ip);
    return false;
  }
  return true;
}

export async function allowMediaUpload(req: express.Request, res: express.Response): Promise<boolean> {
  if (rateConfig.disabled) return true;
  const ip = clientIp(req);
  const wait = await take(`media:${ip}`, rateConfig.mediaPerIp);
  if (wait) {
    reject(res, "media uploads per IP", wait, ip);
    return false;
  }
  return true;
}

export interface TurnSlot {
  /** Free the in-flight slot (idempotent). Call in `finally`. */
  release(): void;
  /** The turn was answered by the runtime without a model call: give the per-session count back. */
  refund(): Promise<void>;
}

/** Gate for chat turns: the per-session lock, the global cap, then the window limits. */
export async function beginChatTurn(req: express.Request, res: express.Response, sessionId: string): Promise<TurnSlot | null> {
  if (inFlightSessions.has(sessionId)) {
    reject(res, "concurrent turn on session", 5, sessionId);
    return null;
  }
  if (inFlightTotal >= rateConfig.maxConcurrent) {
    reject(res, "gateway at capacity", 10, "global");
    return null;
  }
  if (!rateConfig.disabled) {
    const ip = clientIp(req);
    const waitSession = await take(`chat:sess:${sessionId}`, rateConfig.chatPerSession);
    if (waitSession) {
      reject(res, "chat turns per session", waitSession, sessionId);
      return null;
    }
    const waitIp = await take(`chat:ip:${ip}`, rateConfig.chatPerIp);
    if (waitIp) {
      reject(res, "chat turns per IP", waitIp, ip);
      return null;
    }
  }
  inFlightSessions.add(sessionId);
  inFlightTotal++;
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      inFlightSessions.delete(sessionId);
      inFlightTotal--;
    },
    refund: async () => {
      if (rateConfig.disabled) return;
      try {
        await getCounterStore().incr(`rate:chat:sess:${sessionId}`, WINDOW_MS, -1);
      } catch {
        /* best effort */
      }
    },
  };
}

export function rateLimitSnapshot() {
  return {
    disabled: rateConfig.disabled,
    in_flight_turns: inFlightTotal,
    max_concurrent_turns: rateConfig.maxConcurrent,
    limits_per_min: { sessions_per_ip: rateConfig.sessionsPerIp, chat_per_session: rateConfig.chatPerSession, chat_per_ip: rateConfig.chatPerIp, transcribe_per_ip: rateConfig.transcribePerIp, media_per_ip: rateConfig.mediaPerIp },
  };
}
