/**
 * logger.ts — structured JSON logging with trace correlation and redaction.
 *
 * One line per event, so a log shipper or a plain `grep` can work with it. Level gate via
 * LOG_LEVEL (debug|info|warn|error; default info). Every line carries the active span's
 * trace_id/span_id (otel.ts), so logs and traces are one story.
 *
 * WRITTEN OFF THE MAIN THREAD. Node writes stdout synchronously when it is a pipe (which
 * it is under Docker), so a console.log on the request path stalls the event loop for the
 * write. Lines go to a worker thread (log-worker.mjs) that batches them: stdout/stderr,
 * a daily file under AGENT_LOG_DIR (default .data/logs, kept AGENT_LOG_RETENTION_DAYS,
 * default 14) and, when the OpenObserve shipping is configured, the logs stream.
 *
 * TRACE LINES (level "trace", on unless AGENT_TRACE=off) are the diagnostic record of a
 * chat: turn.start, llm.call, tool.call, turn.done, turn.error, http.reject, mcp.tool. Every
 * trace line carries `session` and `turn`, so one grep for a session id gives the story.
 *
 * NEVER log secrets: `redact()` masks token-like values and sensitive keys (extend with
 * AGENT_REDACT_KEYS=key1,key2), phone numbers in free text, and `head()` truncates. A user's
 * bearer token is never part of any logged field.
 */
import { Worker } from "node:worker_threads";
import { resolve } from "node:path";
import { SERVICE_NAMESPACE } from "./config.js";
import { currentTraceIds, otelConfig, otelState, setOtelDiagHook } from "./otel.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = ORDER[(process.env.LOG_LEVEL as LogLevel) in ORDER ? (process.env.LOG_LEVEL as LogLevel) : "info"];
const traceOn = process.env.AGENT_TRACE !== "off";

export const logConfig = {
  dir: process.env.AGENT_LOG_DIR === "" ? "" : resolve(process.env.AGENT_LOG_DIR ?? ".data/logs"),
  retentionDays: Number(process.env.AGENT_LOG_RETENTION_DAYS ?? 14) || 14,
  stdout: process.env.AGENT_LOG_STDOUT !== "false",
  sync: process.env.AGENT_LOG_SYNC === "true",
  /** Everything to stderr — for a process whose stdout is a protocol channel (an MCP child). */
  stderrOnly: process.env.AGENT_LOG_TO_STDERR === "true",
  o2: otelConfig.logsEnabled ? { url: `${otelConfig.o2Url}/api/${otelConfig.org}/${otelConfig.logStream}/_json`, auth: otelConfig.auth as string, env: otelConfig.env, host: otelConfig.host } : null,
};

// ---- transport ---------------------------------------------------------------
let worker: Worker | null = null;
let flushSeq = 0;
const pendingFlushes = new Map<number, () => void>();
function startWorker(): Worker | null {
  if (logConfig.sync) return null;
  try {
    const w = new Worker(new URL("./log-worker.mjs", import.meta.url), {
      workerData: { dir: logConfig.dir, retentionDays: logConfig.retentionDays, stdout: logConfig.stdout, stderrOnly: logConfig.stderrOnly, o2: logConfig.o2 },
      stdout: false,
      stderr: false,
    });
    w.on("message", (m: { op?: string; id?: number }) => {
      if (m?.op === "flushed" && typeof m.id === "number") {
        pendingFlushes.get(m.id)?.();
        pendingFlushes.delete(m.id);
      }
    });
    w.on("error", (e) => {
      console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "log worker failed — falling back to console", error: e.message }));
      worker = null;
    });
    w.unref();
    return w;
  } catch (e) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "log worker could not start — logging on the main thread", error: (e as Error).message }));
    return null;
  }
}
worker = startWorker();

function write(line: string, err: boolean): void {
  if (logConfig.stderrOnly) err = true;
  if (worker) worker.postMessage({ line, err, svc: otelState.service || SERVICE_NAMESPACE });
  else if (err) console.error(line);
  else console.log(line);
}

/** Drain the worker's queue (call before exit; resolves after `timeoutMs` regardless). */
export function flushLogs(timeoutMs = 1000): Promise<void> {
  if (!worker) return Promise.resolve();
  const id = ++flushSeq;
  return new Promise((done) => {
    const t = setTimeout(() => {
      pendingFlushes.delete(id);
      done();
    }, timeoutMs);
    pendingFlushes.set(id, () => {
      clearTimeout(t);
      done();
    });
    worker!.postMessage({ op: "flush", id });
  });
}

// ---- redaction ---------------------------------------------------------------
const extraKeys = (process.env.AGENT_REDACT_KEYS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
/** Keys whose STRING values are masked. Anchored at the end so `ctx_tokens`-style counts pass. */
const SECRET_KEY = new RegExp(`(token|authorization|api[_-]?key|password|passwd|secret|otp|cookie|bearer|private_?notes?|internal_?notes?|file_?name${extraKeys.length ? "|" + extraKeys.join("|") : ""})$`, "i");
const SECRET_VALUE = /^(Bearer\s+)?(eyJ[\w-]+\.[\w-]+\.[\w-]+|[A-Za-z0-9_-]{40,})$/;
/** Phone-like runs: +country forms, or 10–13 bare digits. */
const PHONE = /\+\d[\d\s().-]{7,16}\d|\b\d{10,13}\b/g;
const redactPhones = process.env.AGENT_REDACT_PHONES !== "false";

/** Mask secrets and phone numbers in a value (deep for objects/arrays). */
export function redact<T>(v: T): T {
  if (typeof v === "string") return (SECRET_VALUE.test(v) ? "[redacted]" : redactPhones ? v.replace(PHONE, "[phone]") : v) as unknown as T;
  if (Array.isArray(v)) return v.map(redact) as unknown as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = SECRET_KEY.test(k) && typeof x === "string" && x ? "[redacted]" : redact(x);
    return out as T;
  }
  return v;
}
/** First `n` chars of free text, one line, with an ellipsis and the full length when cut. */
export function head(text: unknown, n = 300): string {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n)}… (${s.length} chars)` : s;
}
/** Compact view of a tool's arguments: every key, short values, arrays as length + first items. */
export function summarize(args: unknown, maxStr = 80): unknown {
  if (Array.isArray(args)) return args.length > 5 ? { length: args.length, first: args.slice(0, 5).map((x) => summarize(x, maxStr)) } : args.map((x) => summarize(x, maxStr));
  if (args && typeof args === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args as Record<string, unknown>)) out[k] = summarize(v, maxStr);
    return redact(out);
  }
  if (typeof args === "string") return head(args, maxStr);
  return args;
}

// ---- api ----------------------------------------------------------------------
function emit(level: LogLevel | "trace", msg: string, fields?: Record<string, unknown>): void {
  if (level !== "trace" && ORDER[level] < threshold) return;
  let line: string;
  try {
    const { msg: text, ...rest } = redact(fields ?? {});
    line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(text !== undefined ? { text } : {}), ...rest, ...(currentTraceIds() ?? {}) });
  } catch {
    line = JSON.stringify({ ts: new Date().toISOString(), level, msg, fields: "[unserialisable]" });
  }
  write(line, level === "error" || level === "warn");
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
  /** Diagnostic trace line (see the header). `kind` is one of the documented kinds. */
  trace: (kind: string, fields: Record<string, unknown>) => {
    if (traceOn) emit("trace", kind, fields);
  },
};

// The OpenTelemetry SDK's own warnings (an exporter that cannot reach its backend) become ordinary log lines.
setOtelDiagHook((level, msg, args) => emit(level, "otel sdk " + level, { detail: head([msg, ...args.map((a) => (a instanceof Error ? a.message : typeof a === "string" ? a : JSON.stringify(a)))].join(" "), 500) }));
