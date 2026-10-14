/**
 * scripts/check-otel.ts — the regression check for the OpenTelemetry seam (ADR-0003,
 * packages/core/src/otel.ts + logger.ts + log-worker.mjs): spans nest and carry the GenAI
 * attributes, the trace context survives the MCP `_meta` hop, metrics reach an exporter, every
 * log line carries the active trace id, and the log worker ships batches to an OpenObserve-shaped
 * endpoint with Basic auth.
 *
 *   npm run check:otel     (no OpenObserve needed — everything is in-memory or a local stub)
 */
import { createServer } from "node:http";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { AggregationTemporality, InMemoryMetricExporter } from "@opentelemetry/sdk-metrics";

// A stub "OpenObserve" for the log shipper, up before the logger loads.
const received: { auth?: string; url?: string; lines: Record<string, unknown>[] }[] = [];
const stub = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      received.push({ auth: req.headers.authorization, url: req.url, lines: JSON.parse(body) });
    } catch {
      received.push({ auth: req.headers.authorization, url: req.url, lines: [] });
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: 200, status: [{ name: "marg_check", successful: 1, failed: 0 }] }));
  });
});
await new Promise<void>((r) => stub.listen(0, "127.0.0.1", () => r()));
const port = (stub.address() as { port: number }).port;
process.env.AGENT_O2_URL = `http://127.0.0.1:${port}`;
process.env.AGENT_O2_USER = "root@example.com";
process.env.AGENT_O2_PASSWORD = "secret";
process.env.AGENT_O2_LOG_STREAM = "marg_check";
process.env.AGENT_LOG_STDOUT = "false";
process.env.AGENT_LOG_DIR = "";
process.env.LOG_LEVEL = "info";
process.env.AGENT_OTEL_CAPTURE_CONTENT = "heads";

const otel = await import("../packages/core/src/otel.js");
const { METRIC_PREFIX } = await import("../packages/core/src/config.js");
const { AUTH_META_KEY } = await import("../packages/core/src/mcp-client.js");
const spans = new InMemorySpanExporter();
const metricsExp = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
otel.initOtel({ service: "marg-check", exporters: { spans, metrics: metricsExp, metricsIntervalMs: 60_000 }, noFetchInstrumentation: true });
const { log, flushLogs } = await import("../packages/core/src/logger.js");

let fail = 0;
const report = (ok: boolean, name: string, detail = ""): void => {
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "\n      " + detail}`);
};

// 1. nesting + attributes + error status
let innerIds: { trace_id: string; span_id: string } | undefined;
await otel.withSpan("invoke_agent support-intake", { attrs: { "gen_ai.operation.name": "invoke_agent", "gen_ai.conversation.id": "s1" } }, async () => {
  await otel.withSpan("chat mock-model", { kind: otel.SpanKind.CLIENT, attrs: { "gen_ai.operation.name": "chat" } }, async (span) => {
    span.setAttributes({ "gen_ai.usage.input_tokens": 1200, "gen_ai.usage.output_tokens": 80, "gen_ai.usage.cost": 0.0003 });
    innerIds = otel.currentTraceIds();
    log.info("hello from inside", { session: "s1" });
    otel.behaviour("attested_dropped", { tool: "validate_ticket_slots", guard: "tags", removed: 2 });
  });
  try {
    await otel.withSpan("execute_tool search_customers", {}, async () => {
      throw new Error("boom");
    });
  } catch {
    /* expected */
  }
});
const finished = spans.getFinishedSpans();
const turn = finished.find((s) => s.name === "invoke_agent support-intake");
const chat = finished.find((s) => s.name === "chat mock-model");
const tool = finished.find((s) => s.name === "execute_tool search_customers");
report(Boolean(turn && chat && tool), `three spans exported (${finished.map((s) => s.name).join(", ")})`);
report(Boolean(chat && turn && chat.parentSpanContext?.spanId === turn.spanContext().spanId), "chat span is a child of the turn span");
report(chat?.attributes["gen_ai.usage.input_tokens"] === 1200 && chat?.attributes["gen_ai.operation.name"] === "chat", "GenAI attributes are on the chat span", JSON.stringify(chat?.attributes));
report(tool?.status.code === otel.SpanStatusCode.ERROR && tool?.events.some((e) => e.name === "exception"), "a throw marks the span ERROR with an exception event");
report(Boolean(chat?.events.some((e) => e.name === "behaviour.attested_dropped")), "behaviour() adds an event on the active span");
report(Boolean(innerIds && innerIds.trace_id === turn?.spanContext().traceId), "currentTraceIds() sees the active span's trace");
report(finished.every((s) => s.resource.attributes["service.name"] === "marg-check"), "resource carries service.name");

// 2. context over the MCP `_meta` hop (inject → extract → child span in the same trace)
const meta: Record<string, unknown> = { [AUTH_META_KEY]: "tok" };
let childTrace = "";
await otel.withSpan("mcp.call search_customers", { kind: otel.SpanKind.CLIENT }, async (span) => {
  otel.injectContext(meta);
  const ctx = otel.extractContext({ TRACEPARENT: meta.traceparent, ...meta }); // header case must not matter
  await otel.runInContext(ctx, () =>
    otel.withSpan("mcp.tool search_customers", { kind: otel.SpanKind.SERVER }, async () => {
      childTrace = otel.currentTraceIds()?.trace_id ?? "";
    })
  );
  report(typeof meta.traceparent === "string" && /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/.test(meta.traceparent as string), "injectContext writes a W3C traceparent into _meta", String(meta.traceparent));
  report(childTrace === span.spanContext().traceId, "extractContext puts the child span in the caller's trace");
});
report(otel.extractContext(undefined) !== undefined && otel.currentTraceIds() === undefined, "outside any span there is no trace id");

// 3. metrics reach the exporter
otel.counter("turns_total").add(1, { domain: "support-intake", ok: true });
otel.histogram("turn_duration_ms", { unit: "ms", boundaries: otel.MS_BUCKETS }).record(1234, { domain: "support-intake" });
otel.registerGauge("check_gauge", () => 42);
await otel.flushOtel();
const names = metricsExp.getMetrics().flatMap((rm) => rm.scopeMetrics.flatMap((sm) => sm.metrics.map((m) => m.descriptor.name)));
const has = (n: string): boolean => names.includes(n) || names.includes(`${METRIC_PREFIX}_${n}`);
report(has("turns_total") && has("turn_duration_ms") && has("behaviour_events_total"), `counters, histograms and the behaviour counter exported (${names.length} instruments, prefix "${METRIC_PREFIX}")`, names.join(","));
report(has("check_gauge") && has("process_event_loop_lag_ms"), "observable gauges (incl. process health) exported", names.join(","));

// 4. log lines: trace id on the line, shipped with auth to <url>/api/<org>/<stream>/_json
await flushLogs(2000);
const batch = received.find((r) => r.lines.some((l) => l.msg === "hello from inside"));
const logLine = JSON.stringify(batch?.lines.find((l) => l.msg === "hello from inside") ?? {});
report(Boolean(batch), "the worker shipped the log batch to the stub OpenObserve", JSON.stringify(received.map((r) => r.url)));
report(batch?.url === "/api/default/marg_check/_json", "shipping URL is /api/<org>/<stream>/_json", String(batch?.url));
report(batch?.auth === `Basic ${Buffer.from("root@example.com:secret").toString("base64")}`, "Basic auth header from AGENT_O2_USER/PASSWORD");
report(logLine.includes(`"trace_id":"${innerIds?.trace_id}"`) && logLine.includes('"span_id"'), "shipped line carries the active span's trace_id/span_id", logLine);
report(logLine.includes('"service":"marg-check"') && logLine.includes('"_timestamp"') && logLine.includes('"env":"'), "shipped line carries service/env/host/_timestamp", logLine);

// 5. normalisation helpers used by span names
report(otel.normalizePath("/v1/items/6a7b70a8f1e2d3c4b5a69788") === "/v1/items/:id", "normalizePath collapses 24-hex ids", otel.normalizePath("/v1/items/6a7b70a8f1e2d3c4b5a69788"));
report(
  otel.providerName("anthropic", "anthropic", "") === "anthropic" &&
    otel.providerName("openai", "openai-compatible", "https://api.openai.com/v1") === "openai" &&
    otel.providerName("vertex", "openai-compatible", "https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/endpoints/openapi") === "gcp.vertex_ai" &&
    otel.providerName("gemini", "openai-compatible", "https://generativelanguage.googleapis.com/v1beta/openai") === "gcp.gemini" &&
    otel.providerName("azure", "openai-compatible", "https://res.openai.azure.com/openai/v1") === "azure.ai.openai" &&
    otel.providerName("bedrock", "openai-compatible", "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1") === "aws.bedrock" &&
    otel.providerName("ollama", "openai-compatible", "http://localhost:11434/v1") === "local",
  "providerName maps endpoints to the semconv vocabulary",
);

stub.close();
await otel.shutdownOtel(1000);
console.log(fail ? `\n${fail} FAILED` : "\nall otel cases pass");
process.exit(fail ? 1 : 0);
