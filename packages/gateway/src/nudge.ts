/**
 * nudge.ts — "still there?" follow-ups for quiet users.
 *
 * When a user stops replying mid-journey the server sends a few friendly reminders on a timer:
 * persisted into the transcript (so a user who closed the tab sees them on resume) AND pushed
 * live over the session's SSE channel. The count resets each time the user actually replies.
 *   AGENT_NUDGE_ENABLED (on)  AGENT_NUDGE_MAX (3)  AGENT_NUDGE_INTERVAL_MS (300000)
 *   AGENT_NUDGE_LINES — "|"-separated custom lines
 * Timers live in this process; in a multi-node deploy they belong to the node that served the last turn.
 */
import type express from "express";
import { envNum, getSession, isCompleted, log, pushMessage, saveSession } from "@marg/core";

export const nudgeConfig = {
  enabled: process.env.AGENT_NUDGE_ENABLED !== "false",
  max: envNum("AGENT_NUDGE_MAX", 3),
  intervalMs: envNum("AGENT_NUDGE_INTERVAL_MS", 300_000),
  lines: (process.env.AGENT_NUDGE_LINES ?? "Still there? 👋 Send the next detail whenever you're free — everything till now is saved.|No hurry — your details are saved. Reply anytime and we'll finish.|I'll pause here 🙂 Everything is saved — message me whenever you want to continue.").split("|").map((s) => s.trim()).filter(Boolean),
};

export function nudgeClientConfig() {
  return { enabled: nudgeConfig.enabled, max: nudgeConfig.max, interval_ms: nudgeConfig.intervalMs };
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Map<string, Set<express.Response>>();

export function cancelNudge(sessionId: string): void {
  const t = timers.get(sessionId);
  if (t) {
    clearTimeout(t);
    timers.delete(sessionId);
  }
}

export function armNudge(sessionId: string, reset: boolean): void {
  if (!nudgeConfig.enabled) return;
  const s = getSession(sessionId);
  if (!s || isCompleted(s)) return;
  if (reset) s.nudge = { count: 0 };
  cancelNudge(sessionId);
  scheduleNext(sessionId);
}

function scheduleNext(sessionId: string): void {
  const t = setTimeout(() => fire(sessionId), nudgeConfig.intervalMs);
  t.unref?.();
  timers.set(sessionId, t);
}

function fire(sessionId: string): void {
  timers.delete(sessionId);
  const s = getSession(sessionId);
  if (!s || isCompleted(s)) return;
  const count = s.nudge?.count ?? 0;
  if (count >= nudgeConfig.max) return;
  const text = nudgeConfig.lines[Math.min(count, nudgeConfig.lines.length - 1)];
  pushMessage(s, { role: "assistant", content: text });
  s.nudge = { count: count + 1, lastAt: Date.now() };
  saveSession(s);
  emit(sessionId, { text, count: s.nudge.count, max: nudgeConfig.max });
  log.info("nudge sent", { session: sessionId, count: s.nudge.count, max: nudgeConfig.max });
  if (s.nudge.count < nudgeConfig.max) scheduleNext(sessionId);
}

function emit(sessionId: string, data: unknown): void {
  const set = listeners.get(sessionId);
  if (!set) return;
  const frame = `event: nudge\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) {
    try {
      res.write(frame);
    } catch {
      /* dead connection — cleaned up on close */
    }
  }
}

/** SSE stream for server-initiated events to an open client (currently `nudge`). Heartbeats keep intermediaries from closing it. */
export function handleSessionEvents(req: express.Request, res: express.Response): void {
  const id = String(req.params.id);
  if (!getSession(id)) {
    res.status(410).json({ error: "Unknown session — call /api/session first." });
    return;
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  res.write("event: ready\ndata: {}\n\n");
  let set = listeners.get(id);
  if (!set) {
    set = new Set();
    listeners.set(id, set);
  }
  set.add(res);
  const hb = setInterval(() => {
    try {
      res.write(": hb\n\n");
    } catch {
      /* closed */
    }
  }, 25_000);
  hb.unref?.();
  req.on("close", () => {
    clearInterval(hb);
    set!.delete(res);
    if (!set!.size) listeners.delete(id);
  });
}

/** Close every open event stream (shutdown). */
export function closeAllEventStreams(): void {
  for (const set of listeners.values()) for (const res of set) res.end();
  listeners.clear();
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}
