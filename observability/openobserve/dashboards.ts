/**
 * dashboards.ts — the starter OpenObserve dashboards and alerts, generated from the metric names
 * the runtime emits (METRIC_PREFIX, default "agent") and the log stream (AGENT_O2_LOG_STREAM,
 * default "<namespace>_agent"), so a renamed product regenerates them:
 *
 *   npm run o2:dashboards      writes dashboards/*.dashboard.json and alerts/*.alert.json next to this file
 *   npm run o2:bootstrap       uploads them (generating in memory when the folders are empty)
 *
 * Panels are PromQL over the OTel metrics (docs/OBSERVABILITY.md lists them) plus SQL tables over
 * the log stream. Layout is OpenObserve's 48-column grid.
 */
export interface PanelSpec {
  title: string;
  type?: "metric" | "line" | "bar" | "table" | "area";
  promql?: string;
  sql?: string;
  legend?: string;
  unit?: string | null;
  decimals?: number;
  w?: number;
  h?: number;
  description?: string;
}
export interface DashboardSpec {
  slug: string;
  title: string;
  description: string;
  panels: PanelSpec[];
}

const baseConfig = (unit: string | null, decimals: number) => ({
  show_legends: true,
  legends_position: "bottom",
  unit,
  decimals,
  line_thickness: 1.5,
  axis_border_show: false,
  connect_nulls: false,
  legend_width: { unit: "px" },
  base_map: { type: "osm" },
  map_view: { zoom: 1, lat: 0, lng: 0 },
  drilldown: [],
  mark_line: [],
  override_config: [],
  no_value_replacement: "",
  wrap_table_cells: false,
});

function panel(spec: PanelSpec, i: number, x: number, y: number, logStream: string): Record<string, unknown> {
  const w = spec.w ?? (spec.type === "metric" ? 8 : spec.type === "table" ? 48 : 24);
  const h = spec.h ?? (spec.type === "metric" ? 4 : spec.type === "table" ? 10 : 8);
  const promql = Boolean(spec.promql);
  return {
    id: `Panel_ID${String(i).padStart(4, "0")}`,
    type: spec.type ?? (promql ? "line" : "table"),
    title: spec.title,
    description: spec.description ?? "",
    config: baseConfig(spec.unit ?? null, spec.decimals ?? 0),
    queryType: promql ? "promql" : "sql",
    queries: [
      {
        query: spec.promql ?? spec.sql ?? "",
        vrlFunctionQuery: "",
        customQuery: true,
        fields: { stream: promql ? "" : logStream, stream_type: promql ? "metrics" : "logs", x: [], y: [], z: [], breakdown: [], filter: { filterType: "group", logicalOperator: "AND", conditions: [] } },
        config: { promql_legend: spec.legend ?? "", layer_type: "scatter", weight_fixed: 1, limit: 0, min: 0, max: 100, time_shift: [] },
      },
    ],
    layout: { x, y, w, h, i, moved: false },
    htmlContent: "",
    markdownContent: "",
  };
}

/** Lay panels out left to right on a 48-column grid, wrapping rows. */
function layout(panels: PanelSpec[], logStream: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let x = 0, y = 0, rowH = 0;
  panels.forEach((p, i) => {
    const w = p.w ?? (p.type === "metric" ? 8 : p.type === "table" ? 48 : 24);
    const h = p.h ?? (p.type === "metric" ? 4 : p.type === "table" ? 10 : 8);
    if (x + w > 48) { x = 0; y += rowH; rowH = 0; }
    out.push(panel(p, i + 1, x, y, logStream));
    x += w;
    rowH = Math.max(rowH, h);
  });
  return out;
}

export function dashboardSpecs(prefix: string, logStream: string): DashboardSpec[] {
  const P = prefix;
  const range = (m: string) => `sum(increase(${P}_${m}[$__range]))`;
  const perMin = (m: string, by: string, sel = "") => `sum(rate(${P}_${m}${sel}[5m])) by (${by}) * 60`;
  const p95 = (m: string, by = "le") => `histogram_quantile(0.95, sum(rate(${P}_${m}_bucket[5m])) by (${by}))`;
  return [
    {
      slug: "overview",
      title: "Overview",
      description: "Turns, completions, errors, latency and cost at a glance; what the runtime had to step in on; recent errors with their trace ids.",
      panels: [
        { title: "Turns", type: "metric", promql: range("turns_total") },
        { title: "Completions", type: "metric", promql: range("completions_total") },
        { title: "Turn errors", type: "metric", promql: range("turn_errors_total") },
        { title: "Active sessions", type: "metric", promql: `sum(${P}_sessions_active)` },
        { title: "LLM cost (USD)", type: "metric", promql: range("llm_cost_usd_total"), decimals: 4 },
        { title: "Rate limited", type: "metric", promql: range("rate_limited_total") },
        { title: "Turns per minute by domain", promql: perMin("turns_total", "domain"), legend: "{domain}" },
        { title: "Who answered (runtime vs model)", promql: perMin("turns_total", "answered_by"), legend: "{answered_by}" },
        { title: "Turn latency p95 (ms)", promql: p95("turn_duration_ms"), unit: "milliseconds", legend: "p95" },
        { title: "Behaviour events by kind", promql: `sum(increase(${P}_behaviour_events_total[5m])) by (kind)`, legend: "{kind}", description: "Runtime interventions on model output and product milestones." },
        { title: "Tool calls per minute by tool", promql: perMin("tool_calls_total", "tool"), legend: "{tool}" },
        { title: "Tool failures per minute", promql: perMin("tool_calls_total", "tool", '{ok="false"}'), legend: "{tool}" },
        { title: "Recent errors", type: "table", sql: `SELECT _timestamp, msg, error, session, trace_id FROM "${logStream}" WHERE level = 'error' ORDER BY _timestamp DESC LIMIT 50` },
      ],
    },
    {
      slug: "llm-cost",
      title: "LLM & cost",
      description: "Spend, tokens, calls, failover and latency per endpoint and model; the circuit breaker; typed decisions by backend.",
      panels: [
        { title: "Cost (USD)", type: "metric", promql: range("llm_cost_usd_total"), decimals: 4 },
        { title: "Tokens", type: "metric", promql: range("llm_tokens_total") },
        { title: "Model calls", type: "metric", promql: range("llm_calls_total") },
        { title: "Failovers", type: "metric", promql: range("llm_failovers_total") },
        { title: "Retries", type: "metric", promql: range("llm_retries_total") },
        { title: "Unavailable", type: "metric", promql: range("llm_unavailable_total"), description: "Calls where every endpoint in the chain failed." },
        { title: "Cost per hour by model (USD)", promql: `sum(increase(${P}_llm_cost_usd_total[1h])) by (model)`, legend: "{model}", decimals: 4 },
        { title: "Tokens per minute by kind", promql: perMin("llm_tokens_total", "kind"), legend: "{kind}" },
        { title: "Calls per minute by endpoint and outcome", promql: perMin("llm_calls_total", "endpoint, outcome"), legend: "{endpoint} {outcome}" },
        { title: "Time to first token p95 (ms)", promql: p95("llm_ttft_ms", "le, endpoint"), unit: "milliseconds", legend: "{endpoint}" },
        { title: "Model call duration p95 (ms)", promql: p95("llm_duration_ms", "le, endpoint"), unit: "milliseconds", legend: "{endpoint}" },
        { title: "Circuit breaker open (1 = open)", promql: `max(${P}_llm_endpoint_open) by (endpoint)`, legend: "{endpoint}" },
        { title: "Typed decisions by backend", promql: `sum(increase(${P}_decisions_total[5m])) by (backend)`, legend: "{backend}" },
      ],
    },
    {
      slug: "runtime-infra",
      title: "Runtime & infra",
      description: "Process health, HTTP traffic and errors, store latency, limits and caps, speech-to-text volume.",
      panels: [
        { title: "Event-loop lag p99 (ms)", promql: `max(${P}_process_event_loop_lag_ms{stat="p99"})`, unit: "milliseconds", legend: "p99" },
        { title: "Memory (bytes)", promql: `max(${P}_process_heap_bytes) or max(${P}_process_rss_bytes)`, unit: "bytes", legend: "heap / rss" },
        { title: "HTTP requests per minute by route", promql: perMin("http_requests_total", "route"), legend: "{route}" },
        { title: "HTTP 5xx per minute", promql: perMin("http_requests_total", "route", '{status=~"5.."}'), legend: "{route}" },
        { title: "HTTP latency p95 by route (ms)", promql: p95("http_duration_ms", "le, route"), unit: "milliseconds", legend: "{route}" },
        { title: "Store latency p95 by store (ms)", promql: p95("store_duration_ms", "le, store"), unit: "milliseconds", legend: "{store}" },
        { title: "Rate limited per minute by kind", promql: perMin("rate_limited_total", "kind"), legend: "{kind}" },
        { title: "Usage capped per minute by scope", promql: perMin("usage_capped_total", "scope"), legend: "{scope}" },
        { title: "Speech-to-text seconds per minute", promql: perMin("stt_seconds_total", "provider"), legend: "{provider}" },
        { title: "Warnings and errors", type: "table", sql: `SELECT _timestamp, level, msg, error, trace_id FROM "${logStream}" WHERE level IN ('warn', 'error') ORDER BY _timestamp DESC LIMIT 50` },
      ],
    },
  ];
}

export function buildDashboards(prefix: string, logStream: string, product: string): { slug: string; dashboard: Record<string, unknown> }[] {
  return dashboardSpecs(prefix, logStream).map((d) => ({
    slug: d.slug,
    dashboard: {
      version: 5,
      dashboardId: "",
      title: `${product} — ${d.title}`,
      description: d.description,
      role: "",
      owner: "",
      created: "2026-10-13T00:00:00.000Z",
      tabs: [{ tabId: "default", name: d.title, panels: layout(d.panels, logStream) }],
      variables: { list: [], showDynamicFilters: true },
      defaultDatetimeDuration: { type: "relative", relativeTimePeriod: "6h" },
    },
  }));
}

export interface AlertSpec {
  name: string;
  description: string;
  metric: string;
  promql: string;
  operator: ">=" | ">" | "<";
  threshold: number;
  period: number;
  frequency: number;
  silence: number;
  priority: 1 | 2 | 3;
}

export function alertSpecs(prefix: string): AlertSpec[] {
  const P = prefix;
  return [
    { name: "turn_errors", description: "3 or more failed chat turns in 10 minutes. Open Overview → Recent errors.", metric: `${P}_turn_errors_total`, promql: `sum(increase(${P}_turn_errors_total[10m]))`, operator: ">=", threshold: 3, period: 10, frequency: 5, silence: 30, priority: 2 },
    { name: "llm_unavailable", description: "Every model endpoint in the chain failed for at least one call in the last 5 minutes — users saw 'briefly unavailable'.", metric: `${P}_llm_unavailable_total`, promql: `sum(increase(${P}_llm_unavailable_total[5m]))`, operator: ">=", threshold: 1, period: 5, frequency: 2, silence: 15, priority: 1 },
    { name: "llm_circuit_open", description: "An endpoint's circuit breaker is open — calls fail over to the next endpoint.", metric: `${P}_llm_endpoint_open`, promql: `max(${P}_llm_endpoint_open)`, operator: ">=", threshold: 1, period: 5, frequency: 2, silence: 15, priority: 2 },
    { name: "event_loop_lag", description: "Event-loop lag p99 above 500 ms — the process is saturated (a hot loop, a huge JSON, too many concurrent turns).", metric: `${P}_process_event_loop_lag_ms`, promql: `max(${P}_process_event_loop_lag_ms{stat="p99"})`, operator: ">", threshold: 500, period: 5, frequency: 2, silence: 15, priority: 2 },
    { name: "llm_cost_hourly", description: "More than 5 USD of model spend in an hour.", metric: `${P}_llm_cost_usd_total`, promql: `sum(increase(${P}_llm_cost_usd_total[1h]))`, operator: ">", threshold: 5, period: 60, frequency: 10, silence: 60, priority: 3 },
    { name: "turn_latency_p95", description: "Turn latency p95 above 30 s over 10 minutes.", metric: `${P}_turn_duration_ms`, promql: `histogram_quantile(0.95, sum(rate(${P}_turn_duration_ms_bucket[10m])) by (le))`, operator: ">", threshold: 30000, period: 10, frequency: 5, silence: 30, priority: 2 },
    { name: "tool_errors", description: "5 or more failed tool calls in 10 minutes — the backend or an MCP server is unhappy.", metric: `${P}_tool_calls_total`, promql: `sum(increase(${P}_tool_calls_total{ok="false"}[10m]))`, operator: ">=", threshold: 5, period: 10, frequency: 5, silence: 30, priority: 2 },
    { name: "rate_limit_burst", description: "20 or more rate-limited requests in 5 minutes — a client in a loop or an attack.", metric: `${P}_rate_limited_total`, promql: `sum(increase(${P}_rate_limited_total[5m]))`, operator: ">=", threshold: 20, period: 5, frequency: 2, silence: 15, priority: 3 },
  ];
}

export function buildAlerts(prefix: string, namespace: string): { name: string; alert: Record<string, unknown> }[] {
  return alertSpecs(prefix).map((a) => ({
    name: `${namespace}_${a.name}`,
    alert: {
      name: `${namespace}_${a.name}`,
      description: a.description,
      stream_type: "metrics",
      stream_name: a.metric,
      is_real_time: false,
      query_condition: { type: "promql", sql: null, conditions: null, promql: a.promql, promql_condition: { column: "value", operator: a.operator, value: a.threshold }, aggregation: null, vrl_function: null, search_event_type: "alerts", multi_time_range: null },
      trigger_condition: { period: a.period, operator: a.operator, threshold: a.threshold, frequency: a.frequency, frequency_type: "minutes", silence: a.silence, cron: "", align_time: false, timezone: "UTC" },
      destinations: [],
      enabled: false,
      context_attributes: { runbook: "docs/OBSERVABILITY.md" },
      row_template: "",
      tz_offset: 0,
      priority: a.priority,
    },
  }));
}
