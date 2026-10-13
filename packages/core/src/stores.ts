/**
 * stores.ts — pluggable durable stores (ADR-0002).
 *
 * By default everything runs in memory / on local files, so dev and CI need no services.
 * When environment URLs are set, two real backends switch on: Redis (shared counters) and
 * MongoDB (sessions, the usage ledger, the event ledger). The rest of the codebase never
 * checks "is Redis on?" — it uses the interfaces here and gets whichever backend is active.
 *
 *  - CounterStore — atomic fixed-window counters (rate limits, usage caps). Redis when
 *    AGENT_REDIS_URL is set, else in-memory. Windows start at first use and reset when they expire.
 *  - Session persistence + usage/event ledgers — Mongo when AGENT_MONGO_URL is set (db
 *    AGENT_MONGO_DB, default "marg"), else files (.sessions/) and JSONL (.data/ledger/).
 *
 * Connections are attempted at startup; an unreachable service logs a warning and falls back.
 * NOTE: in-memory counters are per-process — a multi-node deploy MUST set AGENT_REDIS_URL or
 * every limit silently multiplies by node count (a correctness bug, not a nicety).
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createClient, type RedisClientType } from "redis";
import { MongoClient, type Collection, type Db } from "mongodb";
import { REPO_ROOT } from "./env.js";
import { log } from "./logger.js";
import { MS_BUCKETS, histogram, withSpan } from "./otel.js";

export interface WindowCount {
  count: number;
  ms_to_reset: number;
}

export interface CounterStore {
  /** Atomically add `amount` to `key`'s current window and return the new total. */
  incr(key: string, windowMs: number, amount?: number): Promise<WindowCount>;
  /** Read `key`'s current window without incrementing. */
  peek(key: string, windowMs: number): Promise<WindowCount>;
}

class MemoryCounterStore implements CounterStore {
  private buckets = new Map<string, { count: number; resetAt: number }>();
  async incr(key: string, windowMs: number, amount = 1): Promise<WindowCount> {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs };
      this.buckets.set(key, b);
      if (this.buckets.size > 50_000) for (const [k, v] of this.buckets) if (v.resetAt <= now) this.buckets.delete(k);
    }
    b.count += amount;
    return { count: b.count, ms_to_reset: b.resetAt - now };
  }
  async peek(key: string, windowMs: number): Promise<WindowCount> {
    const now = Date.now();
    const b = this.buckets.get(key);
    if (!b || b.resetAt <= now) return { count: 0, ms_to_reset: windowMs };
    return { count: b.count, ms_to_reset: b.resetAt - now };
  }
}

class RedisCounterStore implements CounterStore {
  constructor(private client: RedisClientType) {}
  async incr(key: string, windowMs: number, amount = 1): Promise<WindowCount> {
    return withSpan("store.redis.incr", { attrs: { "db.system": "redis", "db.operation.name": "INCRBY" } }, async () => {
      const k = `ag:win:${key}`;
      const count = await this.client.incrBy(k, amount);
      await this.client.pExpire(k, windowMs, "NX");
      const ttl = await this.client.pTTL(k);
      return { count, ms_to_reset: ttl > 0 ? ttl : windowMs };
    });
  }
  async peek(key: string, windowMs: number): Promise<WindowCount> {
    const k = `ag:win:${key}`;
    const [v, ttl] = await Promise.all([this.client.get(k), this.client.pTTL(k)]);
    if (v === null || ttl <= 0) return { count: 0, ms_to_reset: windowMs };
    return { count: Number(v), ms_to_reset: ttl };
  }
}

/** One metered chat turn — the durable usage ledger record. */
export interface UsageEvent {
  ts: number;
  session_id: string;
  /** Cap subject: sha256 prefix of the user token, or "session:<id>" without one. */
  subject: string;
  domain: string;
  tokens: { input: number; output: number; cache_read: number; cache_write: number };
  total_tokens: number;
  plan_tokens: number;
  cost_usd: number;
  provider?: string;
  model?: string;
  ms: number;
  tool_calls: number;
  /** A runtime-answered turn (no model call). */
  runtime?: boolean;
}

/** A product event the runtime records (a step settled, a feature viewed, a create). Opaque ids only — never content. */
export interface LedgerEvent {
  ts: number;
  kind: string;
  session_id: string;
  subject?: string;
  domain?: string;
  attrs?: Record<string, string | number | boolean>;
}

let counterStore: CounterStore = new MemoryCounterStore();
let redisClient: RedisClientType | undefined;
let mongoDb: Db | undefined;
let usageCollection: Collection<UsageEvent> | undefined;
let eventCollection: Collection<LedgerEvent> | undefined;

export const storeState = {
  counters: "memory" as "memory" | "redis",
  sessions: "file" as "file" | "mongo",
  usage_ledger: "file" as "file" | "mongo",
};

export function getCounterStore(): CounterStore {
  return counterStore;
}
/** The sessions collection when Mongo is connected, else undefined (file fallback). */
export function mongoSessions(): Collection | undefined {
  return mongoDb?.collection("sessions");
}

const LEDGER_DIR = process.env.AGENT_LEDGER_DIR === "" ? "" : (process.env.AGENT_LEDGER_DIR ?? join(REPO_ROOT, ".data", "ledger"));
function appendJsonl(file: string, row: unknown): void {
  if (!LEDGER_DIR) return;
  try {
    mkdirSync(LEDGER_DIR, { recursive: true });
    appendFileSync(join(LEDGER_DIR, file), JSON.stringify(row) + "\n");
  } catch (e) {
    log.warn("ledger file write failed", { file, error: (e as Error).message });
  }
}

/** Test seam: observe ledger events in-process. */
export const eventTap: { usage?: (e: UsageEvent) => void; event?: (e: LedgerEvent) => void } = {};

/** Append one metered turn to the durable usage ledger. Fire-and-forget: a failed write only logs. */
export function recordUsageEvent(ev: UsageEvent): void {
  eventTap.usage?.(ev);
  if (usageCollection) {
    const t0 = Date.now();
    usageCollection.insertOne(ev).then(() => storeOp("mongo", "usage.insert", true, Date.now() - t0)).catch((e) => {
      storeOp("mongo", "usage.insert", false, Date.now() - t0);
      log.warn("usage ledger write failed", { error: (e as Error).message });
    });
  } else {
    appendJsonl(`usage-${new Date().toISOString().slice(0, 10)}.jsonl`, ev);
  }
}

/** Append a product event (counts and enums only — never a user's text). */
export function recordEvent(ev: LedgerEvent): void {
  eventTap.event?.(ev);
  if (eventCollection) {
    eventCollection.insertOne(ev).catch((e) => log.warn("event ledger write failed", { error: (e as Error).message }));
  } else {
    appendJsonl(`events-${new Date().toISOString().slice(0, 10)}.jsonl`, ev);
  }
}

function storeOp(store: string, op: string, ok: boolean, ms: number): void {
  histogram("store_duration_ms", { unit: "ms", boundaries: MS_BUCKETS }).record(ms, { store, op, ok });
}

function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = "***";
      u.password = "";
    }
    return u.toString();
  } catch {
    return url.replace(/\/\/[^@/]+@/, "//***@");
  }
}

/** Connect whatever AGENT_REDIS_URL / AGENT_MONGO_URL point at. Each failure logs and leaves the fallback in place. */
export async function initStores(): Promise<void> {
  const redisUrl = process.env.AGENT_REDIS_URL;
  if (redisUrl) {
    const client: RedisClientType = createClient({ url: redisUrl, socket: { connectTimeout: 3000 } });
    try {
      client.on("error", (e) => log.warn("redis error", { error: (e as Error).message || String(e) }));
      // node-redis reconnects forever by default, so connect() never settles against a down Redis — bound it.
      await Promise.race([client.connect(), new Promise((_, rej) => setTimeout(() => rej(new Error("connect timeout (4s)")), 4000).unref())]);
      await client.ping();
      redisClient = client;
      counterStore = new RedisCounterStore(client);
      storeState.counters = "redis";
      log.info("counter store connected", { backend: "redis", url: redactUrl(redisUrl) });
    } catch (e) {
      try {
        (client as { destroy?: () => void }).destroy?.();
      } catch {
        /* already dead */
      }
      log.warn("redis unreachable — falling back to in-memory counters (NOT multi-node safe)", { url: redactUrl(redisUrl), error: (e as Error).message });
    }
  }
  const mongoUrl = process.env.AGENT_MONGO_URL;
  if (mongoUrl) {
    try {
      const client = new MongoClient(mongoUrl, { serverSelectionTimeoutMS: 3000 });
      await client.connect();
      const db = client.db(process.env.AGENT_MONGO_DB ?? "marg");
      await db.command({ ping: 1 });
      mongoDb = db;
      usageCollection = db.collection<UsageEvent>("usage_events");
      eventCollection = db.collection<LedgerEvent>("events");
      await usageCollection.createIndex({ subject: 1, ts: -1 }).catch(() => {});
      await eventCollection.createIndex({ kind: 1, ts: -1 }).catch(() => {});
      await db.collection("sessions").createIndex({ updatedAt: -1 }).catch(() => {});
      storeState.sessions = "mongo";
      storeState.usage_ledger = "mongo";
      log.info("document store connected", { backend: "mongo", url: redactUrl(mongoUrl), db: db.databaseName });
    } catch (e) {
      log.warn("mongo unreachable — falling back to file sessions + JSONL ledgers", { url: redactUrl(mongoUrl), error: (e as Error).message });
    }
  }
}

/** Graceful shutdown: close the Redis connection so the process can exit cleanly. */
export async function closeStores(): Promise<void> {
  await redisClient?.quit().catch(() => {});
}
