/**
 * session.ts — one user's chat conversation: history, counters, draft state, persistence.
 *
 * Owns: the in-memory working set (bounded — a node never loads every persisted session into
 * RAM), persistence (MongoDB when configured, else one JSON file per session), lazy hydration on
 * a miss (so a session created on another node still resolves), token/cost accounting, the
 * sanitized transcript clients replay on resume, and history hygiene (a windowed history must
 * never orphan a tool call from its result — that wedges the session with provider 400s).
 *
 * SECURITY: the user's bearer token (authToken) is deliberately NOT persisted. The client
 * re-supplies it per turn, so a restored session picks it back up on its next request. A
 * session id is an id, not a credential: every endpoint that takes one checks the owner.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Completion, HistoryEntry, PreviewState } from "@marg-adk/types";
import { REPO_ROOT, envNum } from "./env.js";
import { mongoSessions } from "./stores.js";
import { log } from "./logger.js";
import type { ChatMessage, TokenUsage } from "./llm.js";
import { extractUiBlocks, linkAllowed } from "./ui-blocks.js";

/** Hard cap on stored messages per session — oldest are dropped on a turn boundary (pushMessage). */
const MAX_HISTORY_MESSAGES = envNum("AGENT_MAX_HISTORY_MESSAGES", 60);
/** How many sessions this process keeps in memory; older idle ones are evicted (they persist). */
const CACHE_MAX = envNum("AGENT_SESSION_CACHE", 2000);
const SESSION_DIR = process.env.AGENT_SESSION_DIR ?? join(REPO_ROOT, ".sessions");

export interface Session {
  id: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt?: number;
  usage: TokenUsage & { calls: number; turns: number; cost_usd?: number };
  /** Domain that handled the previous turn — the router prefers to stay here. */
  activeDomain?: string;
  /** Entity type in play (typed prompts). */
  activeType?: string;
  /** This user's bearer token, passed through to MCP tool calls. Never persisted. */
  authToken?: string;
  /** User id (verified sub, or an unverified decode for scoping only) — persisted, it's an id. */
  userId?: string;
  /** Latest draft state — updated on every validate/preview/create call and persisted. */
  preview?: PreviewState;
  lastContextTokens?: number;
  /** Cross-feature scratch space (media, identity, step scratch). */
  shared: Record<string, unknown>;
  completion?: Completion;
  completedAt?: number;
  nudge?: { count: number; lastAt?: number };
  /** Turn counter (the trace lines' join key). */
  turn?: number;
}

const sessions = new Map<string, Session>();
const touched = new Map<string, number>();

function sessionFile(id: string): string {
  return join(SESSION_DIR, `${id}.json`);
}

function persist(session: Session): void {
  session.updatedAt = Date.now();
  const { authToken: _omit, ...durable } = session;
  const mongo = mongoSessions();
  if (mongo) {
    mongo.replaceOne({ _id: session.id as never }, { _id: session.id, ...durable } as never, { upsert: true }).catch((e) => log.error("session persist failed", { session: session.id, error: (e as Error).message }));
    return;
  }
  try {
    mkdirSync(SESSION_DIR, { recursive: true });
    writeFileSync(sessionFile(session.id), JSON.stringify(durable));
  } catch (e) {
    log.error("session persist failed", { session: session.id, error: (e as Error).message });
  }
}

function touch(session: Session): void {
  touched.set(session.id, Date.now());
  if (sessions.size <= CACHE_MAX) return;
  // Evict the least-recently-touched sessions that are not mid-turn (touched within the last minute).
  const cutoff = Date.now() - 60_000;
  const victims = [...touched.entries()].filter(([, t]) => t < cutoff).sort((a, b) => a[1] - b[1]).slice(0, Math.max(1, sessions.size - CACHE_MAX));
  for (const [id] of victims) {
    sessions.delete(id);
    touched.delete(id);
  }
  if (victims.length) log.debug("session cache evicted", { evicted: victims.length, kept: sessions.size });
}

/** Startup hook: nothing is bulk-loaded (sessions hydrate lazily on first use); only ensures the directory. */
export async function initSessions(): Promise<void> {
  if (!mongoSessions()) {
    try {
      mkdirSync(SESSION_DIR, { recursive: true });
    } catch {
      /* read-only fs — persistence will warn per write */
    }
  }
}

export async function deleteSession(id: string): Promise<boolean> {
  const existed = sessions.delete(id);
  touched.delete(id);
  const mongo = mongoSessions();
  if (mongo) {
    const res = await mongo.deleteOne({ _id: id as never }).catch((e) => {
      log.error("session delete failed", { session: id, error: (e as Error).message });
      return undefined;
    });
    return existed || Boolean(res?.deletedCount);
  }
  try {
    unlinkSync(sessionFile(id));
    return true;
  } catch {
    return existed;
  }
}

/** Data-minimization purge: sessions idle longer than AGENT_SESSION_RETENTION_DAYS are deleted. Off unless set. */
const RETENTION_DAYS = Number(process.env.AGENT_SESSION_RETENTION_DAYS);
export async function purgeExpiredSessions(): Promise<number> {
  if (!Number.isFinite(RETENTION_DAYS) || RETENTION_DAYS <= 0) return 0;
  const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
  let purged = 0;
  const mongo = mongoSessions();
  if (mongo) {
    const res = await mongo.deleteMany({ updatedAt: { $lt: cutoff } }).catch(() => undefined);
    purged = res?.deletedCount ?? 0;
  } else if (existsSync(SESSION_DIR)) {
    for (const f of readdirSync(SESSION_DIR)) {
      if (!f.endsWith(".json")) continue;
      const p = join(SESSION_DIR, f);
      try {
        if (statSync(p).mtimeMs < cutoff) {
          unlinkSync(p);
          purged++;
        }
      } catch {
        /* gone already */
      }
    }
  }
  for (const [id, s] of sessions) if ((s.updatedAt ?? s.createdAt) < cutoff) sessions.delete(id);
  if (purged) log.info("sessions purged", { purged, retention_days: RETENTION_DAYS });
  return purged;
}

/** Create a new empty session. `owner` is the verified user id when the gateway knows it. */
export function createSession(authToken?: string, owner?: string): string {
  const id = randomUUID();
  const session: Session = {
    id,
    messages: [],
    createdAt: Date.now(),
    usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, calls: 0, turns: 0 },
    authToken,
    userId: owner ?? userIdFromToken(authToken),
    shared: {},
    turn: 0,
  };
  sessions.set(id, session);
  touch(session);
  persist(session);
  return id;
}

/**
 * User id from a JWT's `sub` claim — an UNVERIFIED decode, used ONLY to scope session listings.
 * Real authorization happens on every backend call with the token itself; a forged sub could
 * list only its own forged-id sessions, never act as anyone. A deployment that verifies tokens
 * (docs/SDK-AUTH.md) passes the verified id as `owner` instead.
 */
export function userIdFromToken(token?: string): string | undefined {
  const parts = (token ?? "").split(".");
  if (parts.length !== 3) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const sub = claims?.sub ?? claims?.user_id ?? claims?._id;
    return sub ? String(sub) : undefined;
  } catch {
    return undefined;
  }
}

export function saveSession(session: Session): void {
  persist(session);
}
/** Synchronous in-memory lookup — use ensureSession at HTTP entry points (it hydrates on a miss). */
export function getSession(id: string): Session | undefined {
  const s = sessions.get(id);
  if (s) touched.set(id, Date.now());
  return s;
}

/** Resolve a session, lazily hydrating the working set from the backend on a miss (multi-node safety, bounded memory). */
export async function ensureSession(id: string): Promise<Session | undefined> {
  const hit = getSession(id);
  if (hit) return hit;
  if (!id || !/^[A-Za-z0-9-]{8,64}$/.test(id)) return undefined;
  const hydrate = (s: Session): Session => {
    s.shared ??= {};
    s.turn ??= 0;
    const raced = sessions.get(id);
    if (raced) return raced;
    sessions.set(id, s);
    touch(s);
    return s;
  };
  const mongo = mongoSessions();
  if (mongo) {
    try {
      const doc = await mongo.findOne({ _id: id as never });
      if (doc) {
        const { _id, ...rest } = doc as unknown as Session & { _id: string };
        return hydrate({ ...rest, id: _id } as Session);
      }
    } catch (e) {
      log.error("session lazy-load failed", { session: id, error: (e as Error).message });
    }
    return undefined;
  }
  try {
    const s = JSON.parse(readFileSync(sessionFile(id), "utf8")) as Session;
    if (s?.id === id) return hydrate(s);
  } catch {
    /* no file — genuinely unknown */
  }
  return undefined;
}

export function setSessionAuth(id: string, authToken: string, owner?: string): void {
  const s = sessions.get(id);
  if (!s) return;
  s.authToken = authToken;
  s.userId = owner ?? userIdFromToken(authToken) ?? s.userId;
}

export function markCompleted(session: Session, completion: Completion): void {
  if (session.completion) return;
  session.completion = completion;
  session.completedAt = Date.now();
}
export function isCompleted(session: Session): boolean {
  return Boolean(session.completion);
}

export interface SessionSummary {
  session_id: string;
  created_at: number;
  updated_at: number;
  turns: number;
  total_tokens: number;
  active_domain?: string;
  completed: boolean;
  entity_id?: string;
  nudges_sent: number;
  preview: string;
}

function toSummary(s: Session): SessionSummary {
  const firstUser = s.messages.find((m) => m.role === "user" && typeof m.content === "string");
  return {
    session_id: s.id,
    created_at: s.createdAt,
    updated_at: s.updatedAt ?? s.createdAt,
    turns: s.usage.turns,
    total_tokens: sessionTotalTokens(s),
    active_domain: s.activeDomain,
    completed: Boolean(s.completion),
    entity_id: s.completion?.entity_id,
    nudges_sent: s.nudge?.count ?? 0,
    preview: typeof firstUser?.display === "string" ? firstUser.display.slice(0, 80) : typeof firstUser?.content === "string" ? firstUser.content.slice(0, 80) : "",
  };
}

/**
 * Session listing, newest-updated first. `user` undefined ⇒ ALL (admin surface only); a user id ⇒
 * that user's; null ⇒ only sessions with NO user id (so an unauthenticated listing never sees
 * logged-in users' chats). The file backend scans at most 500 newest files.
 */
export async function listSessions(limit = 50, user?: string | null): Promise<SessionSummary[]> {
  const mongo = mongoSessions();
  if (mongo) {
    const query = user === undefined ? {} : user === null ? { $or: [{ userId: null }, { userId: { $exists: false } }] } : { userId: user };
    const docs = await mongo.find(query).sort({ updatedAt: -1 }).limit(limit).toArray();
    return docs.map((doc) => {
      const { _id, ...rest } = doc as unknown as Session & { _id: string };
      return toSummary({ ...rest, id: _id, shared: rest.shared ?? {} } as Session);
    });
  }
  const rows: Session[] = [];
  if (existsSync(SESSION_DIR)) {
    const files = readdirSync(SESSION_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ f, mtime: statSync(join(SESSION_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 500);
    for (const { f } of files) {
      try {
        const s = sessions.get(f.slice(0, -5)) ?? (JSON.parse(readFileSync(join(SESSION_DIR, f), "utf8")) as Session);
        if (s?.id) rows.push(s);
      } catch {
        /* unreadable file */
      }
    }
  }
  for (const s of sessions.values()) if (!rows.some((r) => r.id === s.id)) rows.push(s);
  return rows
    .filter((s) => user === undefined || (user === null ? !s.userId : s.userId === user))
    .sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))
    .slice(0, limit)
    .map(toSummary);
}

/**
 * Sanitized transcript for resume: user + assistant turns only — tool/system messages and raw
 * tool payloads never leave the server. Assistant ```ui fences are parsed back into blocks so the
 * client re-renders chips/cards exactly as first shown; a form's wire reply shows its readable
 * `display`. `openAsk` lets the steps engine redraw the ask that is still open on reload.
 */
export function sessionHistory(session: Session, openAsk?: (s: Session) => { lead?: string; ui: unknown[] } | undefined): { entries: HistoryEntry[]; completion?: Completion; preview?: PreviewState } {
  const entries: HistoryEntry[] = [];
  for (const m of session.messages) {
    if (m.role === "user" && typeof m.content === "string") {
      entries.push({ role: "user", text: m.display ?? m.content, ui: [] });
    } else if (m.role === "assistant" && typeof m.content === "string" && m.content.trim()) {
      const { clean, ui } = extractUiBlocks(m.content);
      if (clean || ui.length) entries.push({ role: "assistant", text: clean, ui });
    }
  }
  for (const e of entries) e.ui = e.ui.filter((b) => (b as { type?: string })?.type !== "link" || linkAllowed((b as { url?: string }).url));
  if (session.completion) {
    const upload = session.completion.upload_link;
    for (const e of entries) e.ui = e.ui.filter((b) => (b as { type?: string })?.type !== "link" || (Boolean(upload) && (b as { url?: string }).url === upload));
  }
  const last = entries[entries.length - 1];
  if (last && last.role === "assistant" && openAsk && !session.completion) {
    const open = openAsk(session);
    if (open && open.ui.length && !last.ui.length) {
      last.ui = open.ui;
      if (open.lead && !last.text) last.text = open.lead;
    }
  }
  return { entries, completion: freshenCompletion(session.completion), preview: session.preview };
}

/** Serve completion links composed from TODAY's templates, not the ones stored at create time — sessions outlive config. */
export function freshenCompletion(completion: Completion | undefined): Completion | undefined {
  if (!completion) return undefined;
  const link = (tmpl: string | undefined) => (tmpl ? tmpl.replace("{entity_id}", encodeURIComponent(completion.entity_id)) : undefined);
  return {
    ...completion,
    entity_url: link(process.env.AGENT_ENTITY_DEEPLINK) ?? (linkAllowed(completion.entity_url) ? completion.entity_url : undefined),
    upload_link: link(process.env.AGENT_UPLOAD_DEEPLINK) ?? (linkAllowed(completion.upload_link) ? completion.upload_link : undefined),
  };
}

export function sessionCount(): number {
  return sessions.size;
}

/** Append a message; when the cap is exceeded, drop whole turns from the front and heal the window (never orphan a tool pair). */
export function pushMessage(session: Session, msg: ChatMessage): void {
  session.messages.push(msg);
  if (session.messages.length > MAX_HISTORY_MESSAGES) {
    session.messages.splice(0, session.messages.length - MAX_HISTORY_MESSAGES);
    sanitizeHistory(session.messages);
  }
}

/**
 * Heal a message window in place: it must start at a user message, and every `tool` result must
 * follow the assistant message that made the call (a cut mid tool-round → both Anthropic and
 * OpenAI answer 400 forever). Returns how many messages were removed.
 */
export function sanitizeHistory(messages: ChatMessage[]): number {
  const before = messages.length;
  const first = messages.findIndex((m) => m.role === "user");
  messages.splice(0, first === -1 ? messages.length : first);
  for (let i = 0; i < messages.length; ) {
    const m = messages[i];
    if (m.role !== "tool") {
      i++;
      continue;
    }
    let j = i - 1;
    while (j >= 0 && messages[j].role === "tool") j--;
    const calls = j >= 0 && messages[j].role === "assistant" ? messages[j].tool_calls ?? [] : [];
    if (calls.some((c) => c.id === m.tool_call_id)) i++;
    else messages.splice(i, 1);
  }
  // an assistant tool_call with no result following it also wedges a provider: drop its calls
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "assistant" || !m.tool_calls?.length) continue;
    const answered = new Set<string>();
    for (let k = i + 1; k < messages.length && messages[k].role === "tool"; k++) answered.add(messages[k].tool_call_id ?? "");
    if (m.tool_calls.every((c) => answered.has(c.id))) continue;
    const kept = m.tool_calls.filter((c) => answered.has(c.id));
    if (kept.length) m.tool_calls = kept;
    else {
      delete m.tool_calls;
      delete m.anthropic_content;
      if (!m.content) {
        messages.splice(i, 1);
        i--;
      }
    }
  }
  return before - messages.length;
}

export function recordUsage(session: Session, usage?: TokenUsage): void {
  if (!usage) return;
  session.usage.calls++;
  session.usage.input += usage.input;
  session.usage.output += usage.output;
  session.usage.cache_read += usage.cache_read;
  session.usage.cache_write += usage.cache_write;
  if (usage.provider) {
    session.usage.cost_usd = (session.usage.cost_usd ?? 0) + (usage.cost_usd ?? 0);
    session.usage.provider = usage.provider;
    session.usage.model = usage.model;
  }
  session.lastContextTokens = usage.input + usage.cache_read;
}

export function sessionTotalTokens(session: Session): number {
  const u = session.usage;
  return u.input + u.output + u.cache_read + u.cache_write;
}

/**
 * PLAN TOKENS — the one unit plans and limits are counted in: a token count weighted by what
 * each kind costs (fresh input and cache writes 1, cached reads 0.1, output 6 by default — the
 * ratios of a typical primary model's price). Measured on real chats, raw totals varied 2.4x
 * against cost and billable-only 8.9x; the weighted count tracks cost with r = 1.00. Users see a
 * PERCENTAGE of their cap, never tokens. Weights: AGENT_PLAN_WEIGHT_{INPUT,CACHED,OUTPUT,CACHE_WRITE}.
 */
const PLAN_WEIGHT = {
  input: Number(process.env.AGENT_PLAN_WEIGHT_INPUT ?? 1) || 1,
  cached: Number(process.env.AGENT_PLAN_WEIGHT_CACHED ?? 0.1) || 0.1,
  output: Number(process.env.AGENT_PLAN_WEIGHT_OUTPUT ?? 6) || 6,
  cache_write: Number(process.env.AGENT_PLAN_WEIGHT_CACHE_WRITE ?? 1) || 1,
};
export function planTokens(u: { input: number; output: number; cache_read: number; cache_write: number }): number {
  return Math.round(u.input * PLAN_WEIGHT.input + u.cache_read * PLAN_WEIGHT.cached + u.output * PLAN_WEIGHT.output + u.cache_write * PLAN_WEIGHT.cache_write);
}
export function sessionPlanTokens(session: Session): number {
  return planTokens(session.usage);
}

export function sessionUsageSummary(session: Session) {
  return {
    session_id: session.id,
    turns: session.usage.turns,
    model_calls: session.usage.calls,
    tokens: { input: session.usage.input, output: session.usage.output, cache_read: session.usage.cache_read, cache_write: session.usage.cache_write, total: sessionTotalTokens(session) },
    plan_tokens: sessionPlanTokens(session),
    cost_usd: +(session.usage.cost_usd ?? 0).toFixed(4),
    provider: session.usage.provider,
    model: session.usage.model,
    context_tokens: session.lastContextTokens ?? 0,
  };
}

/** Live token/cost stats across this process — avg/min/max per chat (ops surface). */
export function getUsageStats() {
  const chats = [...sessions.values()].filter((s) => s.usage.calls > 0);
  const perChat = chats.map((s) => ({ tokens: sessionTotalTokens(s), cost: s.usage.cost_usd ?? 0, turns: s.usage.turns }));
  const totals = chats.reduce(
    (a, s) => ({ input: a.input + s.usage.input, output: a.output + s.usage.output, cache_read: a.cache_read + s.usage.cache_read, cache_write: a.cache_write + s.usage.cache_write, calls: a.calls + s.usage.calls, turns: a.turns + s.usage.turns, cost_usd: a.cost_usd + (s.usage.cost_usd ?? 0) }),
    { input: 0, output: 0, cache_read: 0, cache_write: 0, calls: 0, turns: 0, cost_usd: 0 }
  );
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const stat = (xs: number[]) => (xs.length ? { avg: Math.round(sum(xs) / xs.length), min: Math.min(...xs), max: Math.max(...xs) } : { avg: 0, min: 0, max: 0 });
  return {
    chats_measured: chats.length,
    turns: totals.turns,
    model_calls: totals.calls,
    totals: { ...totals, cost_usd: +totals.cost_usd.toFixed(4) },
    per_chat_tokens: stat(perChat.map((c) => c.tokens)),
    per_turn_tokens_avg: totals.turns ? Math.round(perChat.reduce((a, c) => a + c.tokens, 0) / totals.turns) : 0,
  };
}
