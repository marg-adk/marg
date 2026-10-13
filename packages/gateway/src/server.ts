/**
 * server.ts — the gateway's HTTP server and the entry point of the whole service.
 *
 * An Express server that is the ONLY thing clients ever talk to. It owns the URL surface,
 * applies the cross-cutting concerns (security, rate limits, usage caps, logging, metrics,
 * tracing), and delegates the conversation to the super agent (router.ts) → a domain agent
 * (@marg-adk/core).
 *
 * ONE CHAT TURN
 *  1. The client POSTs {session_id, message[, display]} to /api/chat or /api/chat/stream (or
 *     raw audio to /api/chat/voice).
 *  2. Gates, in order: request shape + session + owner (validChatRequest), rate limits
 *     (beginChatTurn), usage caps (allowTurn). All BEFORE the SSE headers are written.
 *  3. router.ts picks the domain; the domain agent runs (steps, model, tools).
 *  4. The turn is metered, metrics recorded, the nudge re-armed, pending media attached, and the
 *     reply returned — one JSON body, or SSE: delta / tool / preview / done (+ transcript first for voice).
 *
 * ENDPOINT MAP — see docs/CLIENT-PROTOCOL.md. Shutdown: SIGTERM drains in-flight turns (bounded),
 * closes the MCP children, flushes logs and telemetry — a deploy must not lose conversations.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import {
  BRAND,
  REPO_ROOT,
  buildDomainPrompt,
  closeAllMcp,
  closeStores,
  createSession,
  deleteSession,
  ensureSession,
  envNum,
  flushLogs,
  getDomainToolDefs,
  getUsageStats,
  initOtel,
  initSessions,
  initStores,
  isCompleted,
  listCapabilities,
  listSessions,
  llmChainSnapshot,
  log,
  mcpState,
  metricsSnapshot,
  openAskUi,
  otelState,
  primeMetrics,
  purgeExpiredSessions,
  readSkillBody,
  recordRequest,
  recordTurn,
  runDomainAgent,
  sessionCount,
  sessionHistory,
  sessionUsageSummary,
  setSessionAuth,
  shutdownOtel,
  storeState,
  WRITES_ALLOWED,
  type Session,
} from "@marg-adk/core";
import { verdictEnvSnapshot } from "@marg-adk/verdict";
import type { StreamEvent, TurnUsage } from "@marg-adk/types";
import { discoverDomains, installDomains } from "./domains.js";
import { initRouter, routeTurn, routerSnapshot } from "./router.js";
import { allowMediaUpload, allowSessionCreate, allowTranscribe, beginChatTurn, rateLimitSnapshot } from "./rate-limit.js";
import { armNudge, cancelNudge, closeAllEventStreams, handleSessionEvents, nudgeClientConfig } from "./nudge.js";
import { handleTranscribe, sttConfig, sttEnabled, transcribeAudio, SttError } from "./transcribe.js";
import { flushPendingMedia, handleMediaArrange, handleMediaDelete, handleMediaUpload, mediaConfig, mediaDomain, mediaPromptNote, mediaState } from "./media.js";
import { allowTurn, capSnapshot, capStatuses, meterTurn } from "./usage-caps.js";
import { adminGate, bearerFrom, corsOptions, identify, identityOf, ownsSession, requireGatewayKey, requireUserLogin, safeError, securityConfig, securityHeaders } from "./security.js";
import { exchangeEnabled, handleExchange, handleLogout, vaultedToken, verifyAgentToken } from "./auth.js";
import { otelHttp, registerGatewayGauges } from "./telemetry.js";
import { meteringSink } from "./metering-sink.js";
import { looksLikeFormReply } from "@marg-adk/core";

initOtel({ service: process.env.OTEL_SERVICE_NAME ?? "marg-gateway" });
primeMetrics();
registerGatewayGauges();

const PORT = envNum("GATEWAY_PORT", 8787);
// The playground page ships inside this package (public/ beside src/ and dist/); the widget is
// the @marg-adk/widget package (a workspace link here, a dependency when installed from npm).
const PUBLIC_DIR = process.env.AGENT_PUBLIC_DIR ?? fileURLToPath(new URL("../public/", import.meta.url));
const WIDGET_FILE = process.env.AGENT_WIDGET_FILE ?? locateWidget();
const SHARED_SKILLS_DIR = process.env.AGENT_SHARED_SKILLS_DIR ?? join(REPO_ROOT, "shared-skills");
function locateWidget(): string {
  try {
    return fileURLToPath(import.meta.resolve("@marg-adk/widget/widget.js"));
  } catch {
    return join(REPO_ROOT, "packages", "widget", "widget.js");
  }
}

const app = express();
if (process.env.AGENT_TRUST_PROXY === "true") app.set("trust proxy", true);
app.use(otelHttp);
app.use(cors(corsOptions()));
app.use(securityHeaders);
app.use(requireGatewayKey);
app.use(express.json({ limit: "256kb" }));
app.post("/api/auth/exchange", (req, res) => void handleExchange(req, res, identify));
app.use((req, res, next) => void requireUserLogin(req, res, next));
app.post("/api/transcribe", express.raw({ type: () => true, limit: "15mb" }), async (req, res) => {
  if (!(await allowTranscribe(req, res))) return;
  await handleTranscribe(req, res);
});
app.use(express.static(PUBLIC_DIR));

const noStaleCopies = (res: express.Response) => res.setHeader("Cache-Control", "no-cache");
function widgetVersion(): string {
  try {
    const st = statSync(WIDGET_FILE);
    return `${Math.floor(st.mtimeMs)}-${st.size}`;
  } catch {
    return "0";
  }
}
app.get("/widget.js", (_req, res) => {
  noStaleCopies(res);
  res.sendFile(WIDGET_FILE);
});

app.use((req, res, next) => {
  if (!req.path.startsWith("/api/")) return next();
  const t0 = Date.now();
  recordRequest();
  res.on("finish", () => log.info("request", { method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - t0 }));
  next();
});

// ---- health ---------------------------------------------------------------------------
app.get("/api/health", (_req, res) => {
  const domains = discoverDomains();
  const llm = llmChainSnapshot();
  const keyOk = llm.chain.some((c) => c.key_set);
  const noTools = domains.every((d) => getDomainToolDefs(d.name).length === 0);
  const degraded = !keyOk || noTools;
  res.status(degraded ? 503 : 200).json({
    ok: !degraded,
    degraded,
    brand: BRAND,
    writes: WRITES_ALLOWED,
    llm,
    verdict: { ...verdictEnvSnapshot(), router: routerSnapshot() },
    auth: { require_login: securityConfig.requireLogin, verify_url_set: Boolean(securityConfig.verifyUrl), exchange: exchangeEnabled(), admin_key_set: Boolean(securityConfig.adminKey), gateway_keys: securityConfig.gatewayKeys.size },
    stores: storeState,
    otel: otelState,
    stt: { enabled: sttEnabled(), provider: sttConfig.provider || null },
    media: { domain: mediaDomain() ?? null, file_base: mediaConfig.fileBase || null },
    metering: { sink: meteringSink.enabled },
    domains: domains.map((d) => ({ name: d.name, title: d.title, tools: getDomainToolDefs(d.name).length, steps: d.steps ? true : false, examples: (d.route_hints?.examples ?? []).slice(0, 4) })),
    mcp: mcpState(),
    capabilities: listCapabilities(),
    sessions: sessionCount(),
  });
});

// ---- auth -----------------------------------------------------------------------------
app.post("/api/auth/logout", handleLogout);

// ---- sessions -------------------------------------------------------------------------
app.post("/api/session", async (req, res) => {
  if (!(await allowSessionCreate(req, res))) return;
  const identity = identityOf(req);
  const bearer = bearerFrom(req);
  const upstream = bearer && verifyAgentToken(bearer) ? vaultedToken(verifyAgentToken(bearer)!) : bearer;
  res.json({ session_id: createSession(upstream, identity?.sub), nudge: nudgeClientConfig(), brand: BRAND });
});

app.get("/api/sessions", async (req, res) => {
  if (!adminGate(req, res)) return;
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  res.json({ sessions: await listSessions(limit), count: sessionCount() });
});

app.get("/api/my/sessions", async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const identity = identityOf(req);
  const sessions = await listSessions(limit, identity?.sub ?? null);
  res.json({ sessions, count: sessions.length });
});

/** Resolve a session a request names, enforcing ownership (404 on a mismatch — ids are not enumerable). */
async function sessionFor(req: express.Request, res: express.Response, id: string): Promise<Session | null> {
  const session = await ensureSession(id);
  if (!session) {
    res.status(410).json({ error: "Unknown session — call /api/session first." });
    return null;
  }
  if (!ownsSession(req, session)) {
    res.status(404).json({ error: "Unknown session — call /api/session first." });
    return null;
  }
  return session;
}

app.delete("/api/session/:id", async (req, res) => {
  const session = await sessionFor(req, res, String(req.params.id));
  if (!session) return;
  res.json({ deleted: await deleteSession(session.id) });
});

app.get("/api/session/:id/events", async (req, res) => {
  const session = await sessionFor(req, res, String(req.params.id));
  if (!session) return;
  handleSessionEvents(req, res);
});

app.get("/api/session/:id/history", async (req, res) => {
  const session = await sessionFor(req, res, String(req.params.id));
  if (!session) return;
  const domain = discoverDomains().find((d) => d.name === session.activeDomain) ?? discoverDomains()[0];
  const { entries, completion, preview } = sessionHistory(session, domain ? (s) => openAskUi(domain, s) : undefined);
  res.json({ session_id: session.id, entries, completion, preview, completed: isCompleted(session), usage: { caps: await capStatuses(session) }, media: mediaState(session), nudge: nudgeClientConfig() });
});

app.get("/api/session/:id/usage", async (req, res) => {
  const session = await sessionFor(req, res, String(req.params.id));
  if (!session) return;
  res.json({ ...sessionUsageSummary(session), caps: await capStatuses(session) });
});

// ---- media ----------------------------------------------------------------------------
async function mediaSession(req: express.Request, res: express.Response): Promise<Session | null> {
  const id = req.header("x-agent-session") ?? "";
  if (!id) {
    res.status(400).json({ error: "Missing X-Agent-Session header." });
    return null;
  }
  return sessionFor(req, res, id);
}
app.post("/api/media", express.raw({ type: () => true, limit: mediaConfig.maxVideoBytes }), async (req, res) => {
  const session = await mediaSession(req, res);
  if (!session) return;
  if (!(await allowMediaUpload(req, res))) return;
  await handleMediaUpload(req, res, session);
});
app.get("/api/media", async (req, res) => {
  const session = await mediaSession(req, res);
  if (!session) return;
  res.json(mediaState(session));
});
app.patch("/api/media", async (req, res) => {
  const session = await mediaSession(req, res);
  if (!session) return;
  await handleMediaArrange(req, res, session);
});
app.delete("/api/media", async (req, res) => {
  const session = await mediaSession(req, res);
  if (!session) return;
  await handleMediaDelete(req, res, session);
});

// ---- ops surfaces ---------------------------------------------------------------------
app.get("/api/skills", (req, res) => {
  if (!adminGate(req, res)) return;
  const out: { name: string; scope: string; chars: number; body: string }[] = [];
  for (const d of discoverDomains()) {
    for (const shared of d.shared_skills ?? []) {
      const body = readSkillBody(join(SHARED_SKILLS_DIR, shared));
      if (body && !out.some((s) => s.name === shared)) out.push({ name: shared, scope: "shared", chars: body.length, body });
    }
    for (const skill of d.skills) {
      const body = readSkillBody(join(d.dir, skill));
      if (body) out.push({ name: skill, scope: d.name, chars: body.length, body });
    }
  }
  res.json(out);
});
app.get("/api/usage", (req, res) => {
  if (!adminGate(req, res)) return;
  res.json({ since: "gateway start", ...getUsageStats() });
});
app.get("/api/metrics", (req, res) => {
  if (!adminGate(req, res)) return;
  res.json({ ...metricsSnapshot(), rate_limit: rateLimitSnapshot(), usage_caps: capSnapshot(), stores: storeState });
});
app.get("/api/system-prompt", (req, res) => {
  if (!adminGate(req, res)) return;
  const domains = discoverDomains();
  const pick = (req.query.domain as string) || domains[0]?.name;
  const domain = domains.find((d) => d.name === pick);
  if (!domain) {
    res.status(404).json({ error: `Unknown domain "${pick}"`, domains: domains.map((d) => d.name) });
    return;
  }
  const prompt = buildDomainPrompt(domain, typeof req.query.type === "string" ? req.query.type : undefined);
  res.json({ domain: domain.name, domains: domains.map((d) => d.name), prompt, chars: prompt.length, approx_tokens: Math.round(prompt.length / 4) });
});
/** Debug a typed decision through the router's own decider (admin). */
app.post("/api/decide", async (req, res) => {
  if (!adminGate(req, res)) return;
  const { state, questions } = (req.body ?? {}) as { state?: unknown; questions?: unknown };
  if (state === undefined || !questions || typeof questions !== "object") {
    res.status(400).json({ error: "Expected { state, questions }" });
    return;
  }
  try {
    const { classify } = await import("./router.js");
    void classify;
    const { deciderFromEnv } = await import("@marg-adk/verdict");
    const { llmComplete } = await import("./router.js");
    const { decider } = deciderFromEnv({ complete: llmComplete });
    res.json(await decider.decide(state as never, questions as never));
  } catch (e) {
    const { status, body } = safeError("/api/decide", e);
    res.status(status).json(body);
  }
});

// ---- chat -----------------------------------------------------------------------------
async function validChatRequest(req: express.Request, res: express.Response): Promise<{ session: Session; message: string; display?: string } | null> {
  const { session_id, message, display } = (req.body ?? {}) as { session_id?: unknown; message?: unknown; display?: unknown };
  if (typeof session_id !== "string" || typeof message !== "string" || !message.trim()) {
    res.status(400).json({ error: "Expected { session_id, message }" });
    return null;
  }
  if (message.length > securityConfig.maxMessageChars) {
    res.status(400).json({ error: `Message too long (max ${securityConfig.maxMessageChars} characters).` });
    return null;
  }
  const session = await sessionFor(req, res, session_id);
  if (!session) return null;
  if (isCompleted(session) && !session.completion?.editable?.length) {
    res.status(409).json({ error: "This chat is already complete. Start a new one.", completed: true });
    return null;
  }
  const shown = typeof display === "string" && display.trim() && looksLikeFormReply(message) ? display.trim().slice(0, 600) : undefined;
  return { session, message: message.trim(), display: shown };
}

function attachAuth(req: express.Request, session: Session): void {
  const bearer = bearerFrom(req);
  if (!bearer) return;
  const agent = verifyAgentToken(bearer);
  const upstream = agent ? vaultedToken(agent) : bearer;
  if (upstream) setSessionAuth(session.id, upstream, identityOf(req)?.sub);
}

app.post("/api/chat", async (req, res) => {
  const valid = await validChatRequest(req, res);
  if (!valid) return;
  const { session, message, display } = valid;
  const slot = await beginChatTurn(req, res, session.id);
  if (!slot) return;
  cancelNudge(session.id);
  attachAuth(req, session);
  const t0 = Date.now();
  try {
    if (!(await allowTurn(session, res))) return;
    const before = { ...session.usage };
    const { target } = await routeTurn(session.id, message);
    const out = await runDomainAgent(target, session, message, { display, promptTail: mediaPromptNote });
    const ms = Date.now() - t0;
    recordTurn({ domain: out.domain ?? "unknown", ms, tools: out.tool_trace.length, ok: true });
    out.usage = await meterTurn(session, before, { domain: out.domain ?? "unknown", ms, tool_calls: out.tool_trace.length, runtime: Boolean(out.kind) });
    if (out.kind) await slot.refund();
    armNudge(session.id, true);
    if (session.completion) void flushPendingMedia(session);
    res.json(out);
  } catch (e) {
    recordTurn({ domain: "unknown", ms: Date.now() - t0, tools: 0, ok: false });
    const { status, body } = safeError("/api/chat", e);
    res.status(status).json(body);
  } finally {
    slot.release();
  }
});

async function streamTurn(req: express.Request, res: express.Response, session: Session, message: string, display: string | undefined, preEvents: Array<[string, unknown]> = []): Promise<void> {
  const slot = await beginChatTurn(req, res, session.id);
  if (!slot) return;
  cancelNudge(session.id);
  attachAuth(req, session);
  if (!(await allowTurn(session, res))) {
    slot.release();
    return;
  }
  const before = { ...session.usage };
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  for (const [event, data] of preEvents) send(event, data);
  const t0 = Date.now();
  try {
    const { target } = await routeTurn(session.id, message);
    let done: (Extract<StreamEvent, { type: "done" }> & { usage?: TurnUsage }) | undefined;
    await runDomainAgent(target, session, message, {
      display,
      promptTail: mediaPromptNote,
      onEvent: (e) => {
        if (e.type === "done") {
          done = e;
          return;
        }
        const { type, ...rest } = e;
        send(type, rest);
      },
    });
    if (done) {
      const ms = Date.now() - t0;
      recordTurn({ domain: done.domain, ms, tools: done.tool_trace.length, ok: true });
      done.usage = await meterTurn(session, before, { domain: done.domain, ms, tool_calls: done.tool_trace.length, runtime: Boolean(done.kind) });
      if (done.kind) await slot.refund();
      const { type: _t, ...rest } = done;
      send("done", rest);
      if (session.completion) void flushPendingMedia(session);
    }
  } catch (err) {
    recordTurn({ domain: "unknown", ms: Date.now() - t0, tools: 0, ok: false });
    send("error", safeError(req.path, err).body);
  } finally {
    slot.release();
    armNudge(session.id, true);
    res.end();
  }
}

app.post("/api/chat/stream", async (req, res) => {
  const valid = await validChatRequest(req, res);
  if (!valid) return;
  await streamTurn(req, res, valid.session, valid.message, valid.display);
});

app.post("/api/chat/voice", express.raw({ type: () => true, limit: "15mb" }), async (req, res) => {
  const session = await mediaSession(req, res);
  if (!session) return;
  if (isCompleted(session)) {
    res.status(409).json({ error: "This chat is already complete. Start a new one.", completed: true });
    return;
  }
  if (!(await allowTranscribe(req, res))) return;
  let tx;
  try {
    tx = await transcribeAudio(req.body as Buffer, req.header("content-type"));
  } catch (e) {
    if (e instanceof SttError) res.status(e.status).json({ error: e.message });
    else res.status(502).json({ error: "Transcription failed — please try again or type your message." });
    return;
  }
  const message = tx.transcript.slice(0, securityConfig.maxMessageChars);
  const minutes = (tx.duration_s ?? 0) / 60;
  meteringSink.stt(session.userId ?? session.id, session.id, (session.turn ?? 0) + 1, tx.duration_s ?? 0, minutes * sttConfig.pricePerMinute, tx.provider, tx.model);
  await streamTurn(req, res, session, message, undefined, [["transcript", { text: message, language: tx.language, confidence: tx.confidence, duration_s: tx.duration_s }]]);
});

app.get("/", (_req, res) => {
  noStaleCopies(res);
  let html = readFileSync(join(PUBLIC_DIR, "demo.html"), "utf8");
  html = html.replace('src="/widget.js"', `src="/widget.js?v=${widgetVersion()}"`).replace(/__BRAND__/g, BRAND);
  res.type("html").send(html);
});

// ---- startup --------------------------------------------------------------------------
await initStores();
await initSessions();
await purgeExpiredSessions();
setInterval(() => void purgeExpiredSessions(), 86_400_000).unref();
const domains = await installDomains();
const router = initRouter(domains);
const server = app.listen(PORT, () => {
  const llm = llmChainSnapshot();
  log.info("gateway started", { port: PORT, brand: BRAND, chain: llm.chain.map((c) => `${c.name}:${c.model}`), domains: domains.map((d) => d.name), writes: WRITES_ALLOWED, login: securityConfig.requireLogin, router: router.links, otel: otelState.enabled ? otelState.endpoint : "off" });
  console.error(`[gateway] ${BRAND} on http://localhost:${PORT}/  |  <script src="http://localhost:${PORT}/widget.js" data-agent-auto></script>`);
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.warn("shutting down", { signal });
  closeAllEventStreams();
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, envNum("AGENT_SHUTDOWN_GRACE_MS", 10_000));
    server.close(() => {
      clearTimeout(t);
      resolve();
    });
  });
  await closeAllMcp();
  await meteringSink.close();
  await closeStores();
  await shutdownOtel();
  await flushLogs();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
