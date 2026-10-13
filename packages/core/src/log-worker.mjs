// Log sink worker thread (logger.ts posts lines here; see that file for the why).
// Plain ESM JavaScript on purpose: a worker file must load under any runner (tsx in
// dev and Docker, plain node), and the TS loader is not registered in worker threads.
//
// Batches every line posted since the last tick into ONE write per destination, so the
// main thread never does log I/O and the syscall count stays low: stdout/stderr by file
// descriptor (docker logs), a daily file agent-YYYY-MM-DD.jsonl in `dir` when set (files
// older than `retentionDays` removed on start and hourly), and — when `o2` is configured —
// OpenObserve's JSON ingest endpoint, POSTed in batches of up to 500 lines once a second.
// Shipping is best effort with a bounded queue: an unreachable OpenObserve backs off
// (1s → 30s), keeps the newest 20,000 lines, and says so on stderr; the stdout and file
// copies are never affected.
import { parentPort, workerData } from "node:worker_threads";
import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

const { dir, retentionDays, stdout, stderrOnly, o2 } = workerData;
let queue = [];
let scheduled = false;

const today = () => new Date().toISOString().slice(0, 10);

function flush() {
  scheduled = false;
  const batch = queue;
  queue = [];
  let out = "", err = "", file = "";
  for (const m of batch) {
    const line = m.line + "\n";
    if (stdout) {
      if (m.err || stderrOnly) err += line;
      else out += line;
    }
    if (dir) file += line;
    if (o2) enqueueShip(m.line, m.svc);
  }
  try {
    if (out) writeSync(1, out);
    if (err) writeSync(2, err);
  } catch {
    /* a closed pipe must never take the process down */
  }
  if (dir && file) {
    try {
      appendFileSync(join(dir, `agent-${today()}.jsonl`), file);
    } catch {
      /* disk trouble: the stdout copy is still there */
    }
  }
  if (o2 && shipQueue.length >= SHIP_BATCH) void ship();
}

function purge() {
  if (!dir || !(retentionDays > 0)) return;
  const cutoff = Date.now() - retentionDays * 86_400_000;
  try {
    for (const f of readdirSync(dir)) {
      if (!/^agent-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) continue;
      const p = join(dir, f);
      if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
    }
  } catch {
    /* best effort */
  }
}

if (dir) {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* logged lines still reach stdout */
  }
  purge();
  setInterval(purge, 3_600_000).unref();
}

// ---- OpenObserve shipping ------------------------------------------------------------
const SHIP_MAX = 20_000;
const SHIP_BATCH = 500;
const SHIP_INTERVAL_MS = 1000;
let shipQueue = [];
let shipping = null;
let dropped = 0;
let failures = 0;
let nextAllowedAt = 0;
let shipped = 0;

function decorate(line, svc) {
  const m = /^\{"ts":"([^"]+)"/.exec(line);
  const ts = m ? m[1] : new Date().toISOString();
  const s = JSON.stringify(svc || "agent");
  return `{"_timestamp":"${ts}","service":${s},"env":${JSON.stringify(o2.env)},"host":${JSON.stringify(o2.host)},` + line.slice(1);
}
function enqueueShip(line, svc) {
  if (shipQueue.length >= SHIP_MAX) {
    shipQueue.shift();
    dropped++;
  }
  shipQueue.push(decorate(line, svc));
}
function note(level, msg, extra) {
  try {
    writeSync(2, JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }) + "\n");
  } catch {
    /* nothing left to do */
  }
}
function ship() {
  if (shipping || !shipQueue.length || Date.now() < nextAllowedAt) return shipping;
  const batch = shipQueue.splice(0, SHIP_BATCH);
  shipping = (async () => {
    try {
      const res = await fetch(o2.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: o2.auth },
        body: "[" + batch.join(",") + "]",
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
      shipped += batch.length;
      if (failures) note("info", "log shipping recovered", { after_failures: failures, queued: shipQueue.length });
      failures = 0;
      if (dropped) {
        note("warn", "log lines dropped while the log backend was unreachable", { dropped });
        dropped = 0;
      }
    } catch (e) {
      failures++;
      shipQueue = batch.concat(shipQueue).slice(-SHIP_MAX);
      nextAllowedAt = Date.now() + Math.min(30_000, 1000 * 2 ** Math.min(failures, 5));
      if (failures === 1 || failures % 20 === 0) note("warn", "log shipping failed — retrying with backoff", { error: String(e && e.message ? e.message : e).slice(0, 200), queued: shipQueue.length, failures });
    } finally {
      shipping = null;
    }
  })();
  return shipping;
}
if (o2) setInterval(() => void ship(), SHIP_INTERVAL_MS).unref();

parentPort.on("message", (m) => {
  if (m && m.op === "flush") {
    flush();
    const drain = (async () => {
      if (!o2) return;
      await shipping;
      nextAllowedAt = 0;
      while (shipQueue.length) {
        const p = ship();
        if (!p) break;
        await p;
        if (failures) break;
      }
    })();
    Promise.race([drain, new Promise((r) => setTimeout(r, 1200))]).finally(() => parentPort.postMessage({ op: "flushed", id: m.id, shipped, queued: shipQueue.length }));
    return;
  }
  queue.push(m);
  if (!scheduled) {
    scheduled = true;
    setImmediate(flush);
  }
});
