/**
 * otel.ts — the runtime's OpenTelemetry seam: traces + metrics to any OTLP backend
 * (OpenObserve by default), W3C context propagation (HTTP headers in, MCP `_meta` across
 * the child boundary), and the small helpers the rest of the code instruments itself with.
 *
 * What comes in:  initOtel() once per process (gateway, MCP child, checks) with the service
 *                 name; then withSpan()/startSpan()/behaviour()/counter() calls from every
 *                 module on the request path.
 * What goes out:  OTLP/HTTP (protobuf) to <AGENT_O2_URL>/api/<org>/v1/{traces,metrics} (or the
 *                 standard OTEL_EXPORTER_OTLP_ENDPOINT), batched off the request path.
 *                 Without a configured endpoint every call is a no-op — dev and CI need no service.
 *
 * Naming follows the OpenTelemetry GenAI semantic conventions (gen_ai.*) because that is what
 * observability backends' AI views key on; everything of ours is under `agent.*`.
 *
 * Deliberately no auto-instrumentation loader: the app runs under tsx/ESM where module
 * patching is unreliable. Outbound HTTP (fetch) is captured through undici's diagnostics
 * channel, which needs no patching; everything else is an explicit span.
 *
 * Talks to: nothing else in the runtime (logger.ts imports THIS for trace ids, so this file
 * must never import the logger — startup lines go through the diag hook the caller sets).
 *
 * STANDING RULE (ADR-0003): a feature is not done until it is visible on a panel — every new
 * code path gets a span, failures log with the trace id, countable things get a counter or a
 * behaviour() event.
 */
import { hostname } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { context, createContextKey, diag, DiagLogLevel, metrics, propagation, SpanKind, SpanStatusCode, trace, type Attributes, type Context, type Span } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { AlwaysOnSampler, BasicTracerProvider, BatchSpanProcessor, ParentBasedSampler, SimpleSpanProcessor, TraceIdRatioBasedSampler, type SpanExporter, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { MeterProvider, PeriodicExportingMetricReader, type MetricReader, type PushMetricExporter } from "@opentelemetry/sdk-metrics";
// Protobuf on the wire, not OTLP/JSON: OpenObserve rejects JSON traces with non-zero double attributes.
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { REPO_ROOT } from "./env.js";
import { DEPLOY_ENV, METRIC_PREFIX, SERVICE_NAMESPACE } from "./config.js";

export { SpanKind, SpanStatusCode, context as otelContext, trace, type Span, type Attributes, type Context };

// ---- configuration -----------------------------------------------------------------
/** How much of prompts, replies and tool output rides on spans: redacted heads (default), everything (dev), or nothing. */
export type ContentCapture = "heads" | "full" | "off";

function basicAuth(): string | undefined {
  if (process.env.AGENT_O2_TOKEN) return `Basic ${process.env.AGENT_O2_TOKEN}`;
  const user = process.env.AGENT_O2_USER;
  const pass = process.env.AGENT_O2_PASSWORD;
  if (user && pass) return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
  return undefined;
}
function parseHeaderList(s: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (s ?? "").split(",")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function version(): string {
  try {
    return String(JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
}

/** Resolved once at import. `AGENT_O2_URL` + org + credentials describe the OpenObserve instance; `OTEL_EXPORTER_OTLP_ENDPOINT` overrides the OTLP side (a collector in between). */
export const otelConfig = (() => {
  const o2Url = (process.env.AGENT_O2_URL ?? "").replace(/\/+$/, "");
  const org = process.env.AGENT_O2_ORG ?? "default";
  const otlpBase = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? (o2Url ? `${o2Url}/api/${org}` : "")).replace(/\/+$/, "");
  const auth = basicAuth();
  const otlpHeaders = process.env.OTEL_EXPORTER_OTLP_HEADERS ? parseHeaderList(process.env.OTEL_EXPORTER_OTLP_HEADERS) : auth ? { Authorization: auth } : {};
  const ratio = Number(process.env.OTEL_TRACES_SAMPLER_ARG);
  const capture = (process.env.AGENT_OTEL_CAPTURE_CONTENT ?? "heads").toLowerCase();
  return {
    enabled: process.env.AGENT_OTEL !== "off" && Boolean(otlpBase),
    o2Url,
    org,
    auth,
    otlpBase,
    otlpHeaders,
    logStream: process.env.AGENT_O2_LOG_STREAM ?? `${SERVICE_NAMESPACE}_agent`,
    logsEnabled: process.env.AGENT_O2_LOGS !== "off" && Boolean(o2Url && auth),
    env: DEPLOY_ENV,
    host: hostname(),
    version: version(),
    sampleRatio: Number.isFinite(ratio) && ratio > 0 && ratio < 1 ? ratio : 1,
    metricsIntervalMs: Math.max(1000, Number(process.env.AGENT_OTEL_METRICS_INTERVAL_MS ?? 15000) || 15000),
    captureContent: (capture === "full" || capture === "off" ? capture : "heads") as ContentCapture,
  };
})();

// ---- lifecycle ---------------------------------------------------------------------
let tracerProvider: BasicTracerProvider | undefined;
let meterProvider: MeterProvider | undefined;
let unregisterInstrumentations: (() => void) | undefined;
let serviceName = SERVICE_NAMESPACE;
let started = false;

/** What initOtel() decided — for the startup log line and /api/health. */
export const otelState = {
  enabled: false,
  service: "",
  endpoint: "",
  logs: false,
  log_stream: otelConfig.logStream,
  env: otelConfig.env,
  capture: otelConfig.captureContent,
  sample_ratio: otelConfig.sampleRatio,
  exporter: "none" as "none" | "otlp-http" | "memory",
};

export interface InitOtelOptions {
  /** service.name on every span/metric/log line: "marg-gateway", "marg-support-intake-mcp", "marg-evals". */
  service: string;
  /** Test seam: exporters to use instead of OTLP (checks use in-memory ones). */
  exporters?: { spans?: SpanExporter; metrics?: PushMetricExporter; metricsIntervalMs?: number };
  /** Skip undici (fetch) instrumentation — the log worker and checks don't want it. */
  noFetchInstrumentation?: boolean;
}

/**
 * Wire the global tracer + meter providers, the AsyncLocalStorage context manager, the W3C
 * propagator and the fetch instrumentation. Call it FIRST in every entrypoint; calling it twice
 * is a no-op. With no endpoint configured (and no test exporters) it leaves the no-op API
 * globals in place and returns false.
 */
export function initOtel(opts: InitOtelOptions): boolean {
  if (started) return otelState.enabled;
  started = true;
  serviceName = process.env.OTEL_SERVICE_NAME || opts.service;
  otelState.service = serviceName;
  const memory = Boolean(opts.exporters);
  if (!otelConfig.enabled && !memory) return false;

  diag.setLogger({ verbose() {}, debug() {}, info() {}, warn: (m, ...a) => diagHook?.("warn", String(m), a), error: (m, ...a) => diagHook?.("error", String(m), a) }, DiagLogLevel.WARN);

  const resource = resourceFromAttributes({
    "service.name": serviceName,
    "service.version": otelConfig.version,
    "service.namespace": SERVICE_NAMESPACE,
    "service.instance.id": `${otelConfig.host}:${process.pid}`,
    "deployment.environment.name": otelConfig.env,
    "deployment.environment": otelConfig.env,
    "host.name": otelConfig.host,
    "process.pid": process.pid,
    "process.runtime.name": "node",
    "process.runtime.version": process.versions.node,
  });

  const spanExporter = opts.exporters?.spans ?? new OTLPTraceExporter({ url: `${otelConfig.otlpBase}/v1/traces`, headers: otelConfig.otlpHeaders, timeoutMillis: 10_000 });
  const processors: SpanProcessor[] = [memory ? new SimpleSpanProcessor(spanExporter) : new BatchSpanProcessor(spanExporter, { maxQueueSize: 4096, maxExportBatchSize: 512, scheduledDelayMillis: 2000 })];
  tracerProvider = new BasicTracerProvider({
    resource,
    spanProcessors: processors,
    sampler: otelConfig.sampleRatio < 1 ? new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(otelConfig.sampleRatio) }) : new AlwaysOnSampler(),
  });
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(tracerProvider);

  const metricExporter = opts.exporters?.metrics ?? new OTLPMetricExporter({ url: `${otelConfig.otlpBase}/v1/metrics`, headers: otelConfig.otlpHeaders, timeoutMillis: 10_000 });
  const reader: MetricReader = new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: opts.exporters?.metricsIntervalMs ?? otelConfig.metricsIntervalMs, exportTimeoutMillis: 10_000 });
  meterProvider = new MeterProvider({ resource, readers: [reader] });
  metrics.setGlobalMeterProvider(meterProvider);

  if (!opts.noFetchInstrumentation) {
    const o2Host = otelConfig.o2Url ? new URL(otelConfig.o2Url).host : "";
    unregisterInstrumentations = registerInstrumentations({
      instrumentations: [
        new UndiciInstrumentation({
          requireParentforSpans: true,
          ignoreRequestHook: (req) => {
            const host = String((req as { origin?: string }).origin ?? "");
            return Boolean(o2Host && host.includes(o2Host));
          },
          requestHook: (span, req) => {
            try {
              span.updateName(`${(req as { method?: string }).method ?? "HTTP"} ${new URL(String((req as { origin?: string }).origin ?? "")).host}`);
            } catch {
              /* keep the default name */
            }
          },
        }),
      ],
    });
  }

  startProcessMetrics();
  otelState.enabled = true;
  otelState.endpoint = memory ? "memory" : otelConfig.otlpBase;
  otelState.exporter = memory ? "memory" : "otlp-http";
  otelState.logs = otelConfig.logsEnabled && !memory;
  return true;
}

let diagHook: ((level: "warn" | "error", msg: string, args: unknown[]) => void) | undefined;
/** Where the SDK's own warnings go (export failures). logger.ts sets this so they become ordinary log lines. */
export function setOtelDiagHook(fn: typeof diagHook): void {
  diagHook = fn;
}

/** Flush and stop exporters (shutdown path). Resolves after `timeoutMs` regardless. */
export async function shutdownOtel(timeoutMs = 3000): Promise<void> {
  if (!otelState.enabled) return;
  const work = Promise.allSettled([tracerProvider?.forceFlush(), meterProvider?.forceFlush()]).then(() => Promise.allSettled([tracerProvider?.shutdown(), meterProvider?.shutdown()]));
  await Promise.race([work, new Promise((r) => setTimeout(r, timeoutMs).unref())]);
  unregisterInstrumentations?.();
}
/** Push everything buffered so far (tests, checks). */
export async function flushOtel(): Promise<void> {
  await Promise.allSettled([tracerProvider?.forceFlush(), meterProvider?.forceFlush()]);
}

// ---- spans -------------------------------------------------------------------------
export const tracer = () => trace.getTracer(SERVICE_NAMESPACE, otelConfig.version);

export interface SpanOpts {
  kind?: SpanKind;
  attrs?: Attributes;
  parent?: Context;
}

/** Run `fn` inside a new span that is the active span for everything awaited within it. A throw marks the span ERROR and re-throws; the span always ends. */
export async function withSpan<T>(name: string, opts: SpanOpts, fn: (span: Span) => Promise<T> | T): Promise<T> {
  const span = tracer().startSpan(name, { kind: opts.kind ?? SpanKind.INTERNAL, attributes: opts.attrs }, opts.parent ?? context.active());
  try {
    return await context.with(trace.setSpan(opts.parent ?? context.active(), span), () => fn(span));
  } catch (e) {
    failSpan(span, e);
    throw e;
  } finally {
    span.end();
  }
}
/** Synchronous twin of withSpan. */
export function withSpanSync<T>(name: string, opts: SpanOpts, fn: (span: Span) => T): T {
  const span = tracer().startSpan(name, { kind: opts.kind ?? SpanKind.INTERNAL, attributes: opts.attrs }, opts.parent ?? context.active());
  try {
    return context.with(trace.setSpan(opts.parent ?? context.active(), span), () => fn(span));
  } catch (e) {
    failSpan(span, e);
    throw e;
  } finally {
    span.end();
  }
}
/** Start a span you will end yourself (streaming code with several exit points). */
export function startSpan(name: string, opts: SpanOpts = {}): { span: Span; ctx: Context } {
  const parent = opts.parent ?? context.active();
  const span = tracer().startSpan(name, { kind: opts.kind ?? SpanKind.INTERNAL, attributes: opts.attrs }, parent);
  return { span, ctx: trace.setSpan(parent, span) };
}
/** Mark a span failed with the error's message and a recorded exception. */
export function failSpan(span: Span, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  span.recordException(e instanceof Error ? e : new Error(msg));
  span.setStatus({ code: SpanStatusCode.ERROR, message: msg.slice(0, 300) });
  span.setAttribute("error.type", e instanceof Error ? e.name : "Error");
}
export const activeSpan = (): Span | undefined => trace.getActiveSpan();
export function setAttrs(attrs: Attributes): void {
  trace.getActiveSpan()?.setAttributes(attrs);
}
export function spanEvent(name: string, attrs?: Attributes): void {
  trace.getActiveSpan()?.addEvent(name, attrs);
}
/** trace_id/span_id of the active span for log correlation; undefined outside any span or when tracing is off. */
export function currentTraceIds(): { trace_id: string; span_id: string } | undefined {
  const sc = trace.getActiveSpan()?.spanContext();
  if (!sc || !sc.traceId || /^0+$/.test(sc.traceId)) return undefined;
  return { trace_id: sc.traceId, span_id: sc.spanId };
}
export const currentTraceId = (): string | undefined => currentTraceIds()?.trace_id;

// ---- context propagation across processes -----------------------------------------
export function injectContext(carrier: Record<string, unknown>, ctx: Context = context.active()): void {
  propagation.inject(ctx, carrier, { set: (c, k, v) => ((c as Record<string, unknown>)[k] = v) });
}
export function extractContext(carrier: Record<string, unknown> | undefined): Context {
  if (!carrier) return context.active();
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(carrier)) if (typeof v === "string") lower[k.toLowerCase()] = v;
  return propagation.extract(context.active(), lower, { get: (c, k) => (c as Record<string, string>)[k.toLowerCase()], keys: (c) => Object.keys(c as Record<string, string>) });
}
export const runInContext = <T>(ctx: Context, fn: () => T): T => context.with(ctx, fn);

// ---- request-scoped tags ----------------------------------------------------------------
const EVAL_KEY = createContextKey("agent.eval.scenario");
/** Attach an eval scenario name to the context so the turn span can be tagged (`X-Agent-Eval` header). */
export const withEvalTag = (scenario: string, ctx: Context = context.active()): Context => ctx.setValue(EVAL_KEY, scenario);
export const evalTag = (): string | undefined => context.active().getValue(EVAL_KEY) as string | undefined;

// ---- metrics -------------------------------------------------------------------------
type Counter = ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]>;
type Histogram = ReturnType<ReturnType<typeof metrics.getMeter>["createHistogram"]>;
type UpDown = ReturnType<ReturnType<typeof metrics.getMeter>["createUpDownCounter"]>;
const counters = new Map<string, Counter>();
const histograms = new Map<string, Histogram>();
const updowns = new Map<string, UpDown>();
const meter = () => metrics.getMeter(SERVICE_NAMESPACE, otelConfig.version);
/** Instruments are created lazily on first use, i.e. after initOtel() ran at process start. Names are given WITHOUT the prefix. */
export function counter(name: string, opts?: { description?: string; unit?: string }): Counter {
  const full = name.startsWith("gen_ai") ? name : `${METRIC_PREFIX}_${name}`;
  let c = counters.get(full);
  if (!c) counters.set(full, (c = meter().createCounter(full, opts)));
  return c;
}
export function histogram(name: string, opts?: { description?: string; unit?: string; boundaries?: number[] }): Histogram {
  const full = name.startsWith("gen_ai") ? name : `${METRIC_PREFIX}_${name}`;
  let h = histograms.get(full);
  if (!h) histograms.set(full, (h = meter().createHistogram(full, { description: opts?.description, unit: opts?.unit, advice: opts?.boundaries ? { explicitBucketBoundaries: opts.boundaries } : undefined })));
  return h;
}
export function upDownCounter(name: string, opts?: { description?: string; unit?: string }): UpDown {
  const full = `${METRIC_PREFIX}_${name}`;
  let u = updowns.get(full);
  if (!u) updowns.set(full, (u = meter().createUpDownCounter(full, opts)));
  return u;
}
const gauges = new Set<string>();
/** A gauge read by callback at export time (active sessions, circuit state…). Registering twice with the same name is ignored. */
export function registerGauge(name: string, read: () => number | Array<{ value: number; attrs?: Attributes }>, opts?: { description?: string; unit?: string }): void {
  const full = `${METRIC_PREFIX}_${name}`;
  if (gauges.has(full)) return;
  gauges.add(full);
  meter().createObservableGauge(full, opts).addCallback((r) => {
    const v = read();
    if (typeof v === "number") r.observe(v);
    else for (const x of v) r.observe(x.value, x.attrs);
  });
}

/** Millisecond buckets that resolve both a 40 ms store call and a 90 s turn. */
export const MS_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2000, 4000, 8000, 15000, 30000, 60000, 120000];

/**
 * A behaviour event: the runtime stepped in on the model's output (a guard dropped values, chips
 * were injected, a create was refused…) or a product milestone happened (entity created, a step
 * settled). One counter series per kind + an event on the active span, so the behaviour panel and
 * the turn's trace tell the same story. Labels are low-cardinality — never free text.
 */
export function behaviour(kind: string, attrs: Attributes = {}): void {
  counter("behaviour_events_total", { description: "Runtime interventions on model output and product milestones, by kind" }).add(1, { kind, ...pick(attrs, ["domain", "tool", "guard", "type", "step", "via"]) });
  trace.getActiveSpan()?.addEvent(`behaviour.${kind}`, attrs);
}
function pick(attrs: Attributes, keys: string[]): Attributes {
  const out: Attributes = {};
  for (const k of keys) if (attrs[k] !== undefined) out[k] = attrs[k];
  return out;
}

// ---- process health ----------------------------------------------------------------
let processMetricsStarted = false;
function startProcessMetrics(): void {
  if (processMetricsStarted) return;
  processMetricsStarted = true;
  const lag = monitorEventLoopDelay({ resolution: 20 });
  lag.enable();
  registerGauge("process_event_loop_lag_ms", () => {
    const v = [{ value: lag.mean / 1e6, attrs: { stat: "mean" } }, { value: lag.percentile(99) / 1e6, attrs: { stat: "p99" } }, { value: lag.max / 1e6, attrs: { stat: "max" } }];
    lag.reset();
    return v;
  }, { unit: "ms", description: "Event-loop delay since the last export" });
  registerGauge("process_heap_bytes", () => process.memoryUsage().heapUsed, { unit: "By" });
  registerGauge("process_rss_bytes", () => process.memoryUsage().rss, { unit: "By" });
  registerGauge("process_uptime_s", () => process.uptime(), { unit: "s" });
}

// ---- helpers shared by instrumentation sites ----------------------------------------
/** Collapse ids out of a path so it groups: 24-hex ids, UUIDs and long numbers → `:id`. */
export function normalizePath(path: string): string {
  return path
    .replace(/[0-9a-f]{24}/gi, ":id")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id")
    .replace(/\/\d{3,}(?=\/|$)/g, "/:n");
}
/** Provider name in the semconv vocabulary from a chain endpoint's kind/base. */
export function providerName(name: string, kind: string, base: string): string {
  if (kind === "anthropic") return "anthropic";
  if (kind === "mock") return "mock";
  // the label comes from the endpoint's host, parsed — never a substring match over the URL
  let host = "";
  try {
    host = new URL(base).hostname.toLowerCase();
  } catch {
    return name;
  }
  const under = (...domains: string[]): boolean => domains.some((d) => host === d || host.endsWith("." + d));
  if (under("localhost") || host === "127.0.0.1" || host === "[::1]" || host === "::1" || host.endsWith(".local")) return "local";
  if (under("openai.azure.com", "cognitiveservices.azure.com")) return "azure.ai.openai";
  if (host.endsWith("aiplatform.googleapis.com")) return "gcp.vertex_ai"; // regional hosts: us-central1-aiplatform.googleapis.com
  if (under("googleapis.com")) return "gcp.gemini";
  if (under("openai.com")) return "openai";
  if (under("amazonaws.com")) return "aws.bedrock";
  if (under("x.ai")) return "x_ai";
  if (under("cohere.ai", "cohere.com")) return "cohere";
  if (under("perplexity.ai")) return "perplexity";
  if (under("huggingface.co")) return "huggingface";
  if (under("nvidia.com")) return "nvidia";
  if (under("cerebras.ai")) return "cerebras";
  if (under("deepseek.com")) return "deepseek";
  if (under("fireworks.ai")) return "fireworks";
  if (under("together.xyz", "together.ai")) return "together";
  if (under("groq.com")) return "groq";
  if (under("mistral.ai")) return "mistral";
  if (under("openrouter.ai")) return "openrouter";
  return name;
}
