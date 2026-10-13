/**
 * metrics.ts — in-process health counters + a rolling error-rate alarm.
 *
 * What comes in:  small `record*` calls from the gateway (a request happened, a turn
 *                 finished, a request was rate limited or capped).
 * What goes out:  metricsSnapshot(), the JSON served at /api/metrics — and, when the
 *                 recent error rate is too high, an ALERT log line plus an optional
 *                 webhook POST (AGENT_ALERT_WEBHOOK — the seam a deploy wires to Slack/
 *                 PagerDuty; nothing is sent by default).
 *
 * Process-scoped (reset on restart). The durable, cross-node view is OpenTelemetry
 * (otel.ts); these counters are the zero-dependency fallback and the health probe's input.
 */
import { log } from "./logger.js";
import { counter } from "./otel.js";
import { BRAND } from "./config.js";

interface DomainStat {
  turns: number;
  errors: number;
  tool_calls: number;
  latency_ms_total: number;
  latency_ms_max: number;
}

const started = Date.now();
const domains = new Map<string, DomainStat>();
let requests = 0;
let errors = 0;
let rateLimited = 0;
let capped = 0;

const WINDOW = 50;
const ALERT_RATIO = Number(process.env.AGENT_ALERT_ERROR_RATIO ?? "0.5");
const recent: boolean[] = [];
let alerting = false;

function stat(domain: string): DomainStat {
  let s = domains.get(domain);
  if (!s) {
    s = { turns: 0, errors: 0, tool_calls: 0, latency_ms_total: 0, latency_ms_max: 0 };
    domains.set(domain, s);
  }
  return s;
}

/**
 * Create the counter series that panels and alerts reference before the first real event, so
 * the metric streams exist from the first export (an alert on a stream that does not exist yet
 * cannot be saved). Called once at gateway startup after initOtel().
 */
export function primeMetrics(): void {
  counter("rate_limited_total", { description: "Requests refused with 429 by the rate limiter, by limit" }).add(0, { kind: "startup" });
  counter("usage_capped_total", { description: "Turns refused because a usage cap was exhausted, by scope" }).add(0, { scope: "startup" });
  counter("alerts_fired_total", { description: "In-process error-rate alarms raised" }).add(0, { alert: "startup" });
  for (const name of ["llm_unavailable_total", "llm_failovers_total", "llm_retries_total", "llm_circuit_opened_total", "completions_total", "behaviour_events_total", "turn_errors_total", "tool_calls_total", "decisions_total"]) {
    counter(name).add(0, { kind: "startup" });
  }
}

export function recordRequest(): void {
  requests++;
}
export function recordRateLimited(kind = "unknown"): void {
  rateLimited++;
  counter("rate_limited_total", { description: "Requests refused with 429 by the rate limiter, by limit" }).add(1, { kind });
}
export function recordCapped(scope = "unknown"): void {
  capped++;
  counter("usage_capped_total", { description: "Turns refused because a usage cap was exhausted, by scope" }).add(1, { scope });
}

/** Record a completed chat turn's outcome for monitoring + alerting. */
export function recordTurn(opts: { domain: string; ms: number; tools: number; ok: boolean }): void {
  const s = stat(opts.domain);
  s.turns++;
  s.tool_calls += opts.tools;
  s.latency_ms_total += opts.ms;
  s.latency_ms_max = Math.max(s.latency_ms_max, opts.ms);
  if (!opts.ok) {
    s.errors++;
    errors++;
    counter("turn_errors_total", { description: "Turns that ended in an error" }).add(1, { domain: opts.domain });
  }
  recent.push(!opts.ok);
  if (recent.length > WINDOW) recent.shift();
  checkAlert();
}

/** Raise (or clear) the error-rate alarm with hysteresis: stays raised until the ratio drops below half the threshold. */
function checkAlert(): void {
  if (recent.length < 10) return;
  const ratio = recent.filter(Boolean).length / recent.length;
  if (ratio >= ALERT_RATIO && !alerting) {
    alerting = true;
    fireAlert(ratio);
  } else if (ratio < ALERT_RATIO / 2) {
    alerting = false;
  }
}

function fireAlert(ratio: number): void {
  const payload = { alert: "error_rate_high", ratio: +ratio.toFixed(2), window: recent.length, threshold: ALERT_RATIO };
  log.error("ALERT error_rate_high", payload);
  counter("alerts_fired_total", { description: "In-process error-rate alarms raised" }).add(1, { alert: "error_rate_high" });
  const url = process.env.AGENT_ALERT_WEBHOOK;
  if (url) {
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `${BRAND} gateway: error rate ${payload.ratio} over last ${payload.window} turns` }),
    }).catch((e) => log.warn("alert webhook failed", { error: (e as Error).message }));
  }
}

/** The full metrics report served at GET /api/metrics. */
export function metricsSnapshot() {
  return {
    uptime_s: Math.round((Date.now() - started) / 1000),
    requests_total: requests,
    errors_total: errors,
    rate_limited_total: rateLimited,
    usage_capped_total: capped,
    error_ratio_recent: recent.length ? +(recent.filter(Boolean).length / recent.length).toFixed(3) : 0,
    alerting,
    domains: Object.fromEntries(
      [...domains.entries()].map(([name, s]) => [
        name,
        {
          turns: s.turns,
          errors: s.errors,
          tool_calls: s.tool_calls,
          latency_ms_avg: s.turns ? Math.round(s.latency_ms_total / s.turns) : 0,
          latency_ms_max: s.latency_ms_max,
        },
      ])
    ),
  };
}
