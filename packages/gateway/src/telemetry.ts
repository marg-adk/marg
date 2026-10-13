/**
 * telemetry.ts — the gateway's HTTP-level OpenTelemetry.
 *
 * One Express middleware, `otelHttp`, opens a SERVER span for every /api request, runs the rest
 * of the chain inside it (so the turn's `invoke_agent`, `chat`, `execute_tool` and store spans all
 * hang under one trace), and closes it with the route template, the status code and the session
 * id. It records the HTTP metrics and answers every request with an `X-Trace-Id` header — the id
 * a user-facing error can quote and an engineer can paste into the observability backend.
 *
 * Eval runs tag their requests with `X-Agent-Eval: <scenario>`; the tag lands on the turn span as
 * `agent.eval.scenario`, so eval traffic is one filter away from production traffic on every panel.
 */
import type express from "express";
import { MS_BUCKETS, SpanKind, SpanStatusCode, counter, extractContext, histogram, normalizePath, otelContext, registerGauge, sessionCount, startSpan, withEvalTag } from "@marg/core";

function sessionOf(req: express.Request): string | undefined {
  const body = req.body as { session_id?: unknown } | undefined;
  if (body && typeof body === "object" && typeof body.session_id === "string") return body.session_id;
  const header = req.header("x-agent-session");
  if (header) return header;
  const m = /^\/api\/session\/([^/]+)/.exec(req.path);
  return m?.[1];
}

export function otelHttp(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!req.path.startsWith("/api/")) return next();
  const routeGuess = normalizePath(req.path);
  const { span, ctx } = startSpan(`${req.method} ${routeGuess}`, {
    kind: SpanKind.SERVER,
    parent: extractContext(req.headers as Record<string, unknown>),
    attrs: {
      "http.request.method": req.method,
      "url.path": req.path,
      "url.scheme": req.protocol,
      "server.address": req.hostname,
      "client.address": req.ip ?? "",
      "user_agent.original": (req.header("user-agent") ?? "").slice(0, 200),
      ...(req.header("content-length") ? { "http.request.body.size": Number(req.header("content-length")) } : {}),
    },
  });
  const scenario = req.header("x-agent-eval");
  const runCtx = scenario ? withEvalTag(scenario.slice(0, 120), ctx) : ctx;
  if (scenario) span.setAttribute("agent.eval.scenario", scenario.slice(0, 120));
  res.setHeader("X-Trace-Id", span.spanContext().traceId);
  const t0 = Date.now();
  let ended = false;
  const finish = (aborted: boolean) => {
    if (ended) return;
    ended = true;
    const route = req.route?.path ? String(req.route.path) : routeGuess;
    const session = sessionOf(req);
    const ms = Date.now() - t0;
    span.updateName(`${req.method} ${route}`);
    span.setAttributes({ "http.route": route, "http.response.status_code": res.statusCode, "agent.http.ms": ms, "agent.http.aborted": aborted, ...(session ? { "session.id": session, "gen_ai.conversation.id": session } : {}) });
    if (res.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${res.statusCode}` });
    counter("http_requests_total", { description: "API requests by route, method and status" }).add(1, { route, method: req.method, status: res.statusCode, aborted });
    histogram("http_duration_ms", { unit: "ms", boundaries: MS_BUCKETS }).record(ms, { route, method: req.method });
    span.end();
  };
  res.on("finish", () => finish(false));
  res.on("close", () => finish(!res.writableFinished));
  otelContext.with(runCtx, () => next());
}

export function registerGatewayGauges(): void {
  registerGauge("sessions_active", () => sessionCount(), { description: "Sessions in this process's working set" });
}
