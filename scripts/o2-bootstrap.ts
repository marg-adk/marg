/**
 * scripts/o2-bootstrap.ts — make an OpenObserve instance ready for the agent (ADR-0003).
 * Idempotent: run it after every deploy or dashboard change.
 *
 *   1. waits for /healthz
 *   2. org settings: trace_id / span_id field names (log ↔ trace links), gen_ai agent mapping
 *   3. stream settings: retention + indexed / full-text fields on the log stream, retention on traces
 *   4. a folder named after the brand for dashboards and for alerts
 *   5. dashboards from observability/openobserve/dashboards/*.dashboard.json (generated in memory
 *      when the folder is empty) — upsert by title
 *   6. an alert template + webhook destination (AGENT_ALERT_WEBHOOK, when set)
 *   7. alerts from observability/openobserve/alerts/*.alert.json — upsert by name; enabled only
 *      when a destination exists, unless O2_ALERTS_ENABLED=true|false forces it
 *
 * Env: AGENT_O2_URL, AGENT_O2_ORG (default), AGENT_O2_USER + AGENT_O2_PASSWORD (or AGENT_O2_TOKEN),
 *      AGENT_ALERT_WEBHOOK, O2_RETENTION_DAYS, O2_ALERTS_ENABLED. Reads .env like the gateway.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BRAND, METRIC_PREFIX, SERVICE_NAMESPACE } from "../packages/core/src/config.js";
import { REPO_ROOT } from "../packages/core/src/env.js";
import { buildAlerts, buildDashboards } from "../observability/openobserve/dashboards.js";

const url = (process.env.AGENT_O2_URL ?? "http://localhost:5080").replace(/\/+$/, "");
const org = process.env.AGENT_O2_ORG ?? "default";
const auth = process.env.AGENT_O2_TOKEN
  ? `Basic ${process.env.AGENT_O2_TOKEN}`
  : process.env.AGENT_O2_USER && process.env.AGENT_O2_PASSWORD
    ? `Basic ${Buffer.from(`${process.env.AGENT_O2_USER}:${process.env.AGENT_O2_PASSWORD}`).toString("base64")}`
    : undefined;
if (!auth) {
  console.error("Set AGENT_O2_USER + AGENT_O2_PASSWORD (or AGENT_O2_TOKEN) — the OpenObserve root login.");
  process.exit(2);
}
const webhook = process.env.AGENT_ALERT_WEBHOOK ?? "";
const retention = Number(process.env.O2_RETENTION_DAYS ?? 0) || 0;
const alertsEnabled = process.env.O2_ALERTS_ENABLED ? process.env.O2_ALERTS_ENABLED === "true" : Boolean(webhook);
const FOLDER = BRAND;
const logStream = process.env.AGENT_O2_LOG_STREAM ?? `${SERVICE_NAMESPACE}_agent`;
const dashboardsDir = join(REPO_ROOT, "observability", "openobserve", "dashboards");
const alertsDir = join(REPO_ROOT, "observability", "openobserve", "alerts");

type Json = any;
async function call(method: string, path: string, body?: unknown, quiet = false): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${url}${path}`, { method, headers: { Authorization: auth!, "Content-Type": "application/json", Accept: "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  let parsed: Json = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* plain text */
  }
  if (!res.ok && !quiet) console.warn(`  ! ${method} ${path} → ${res.status} ${typeof parsed === "string" ? parsed.slice(0, 200) : JSON.stringify(parsed).slice(0, 300)}`);
  return { status: res.status, body: parsed };
}
const ok = (r: { status: number }): boolean => r.status >= 200 && r.status < 300;
const step = (s: string): void => console.log(`\n${s}`);
const done = (s: string): void => console.log(`  ✓ ${s}`);

// 1. health
step("OpenObserve");
for (let i = 0; ; i++) {
  const up = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok).catch(() => false);
  if (up) break;
  if (i >= 30) {
    console.error(`${url}/healthz not answering — is OpenObserve up? (docker compose -f observability/docker-compose.yml up -d)`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 1000));
}
done(`${url} (org ${org})`);

// 2. org settings
step("Org settings");
const settings = await call("GET", `/api/${org}/settings`);
const cur = settings.body?.data ?? {};
if (cur.trace_id_field_name !== "trace_id" || cur.span_id_field_name !== "span_id") {
  const r = await call("POST", `/api/${org}/settings`, { trace_id_field_name: "trace_id", span_id_field_name: "span_id" });
  if (ok(r)) done("trace_id / span_id are the log ↔ trace link fields");
} else done("trace_id / span_id already the link fields");
const mapping = { agent_name_fields: ["gen_ai.agent.name", `${METRIC_PREFIX}.domain`, "service.name"], agent_id_fields: ["gen_ai.agent.id"], env_fields: ["deployment.environment.name", "deployment.environment"], version_fields: ["service.version"] };
let m = await call("PUT", `/api/${org}/settings/gen_ai/agent_mapping`, mapping, true);
if (!ok(m)) m = await call("PUT", `/${org}/settings/gen_ai/agent_mapping`, mapping, true);
if (ok(m)) done("gen_ai agent mapping (agent name/id/env/version fallbacks)");
else console.log(`  - gen_ai agent mapping not applied (${m.status}) — optional; the AI views still key on gen_ai.agent.name`);

// 3. stream settings (streams appear on first ingest — a 404 here just means nothing was sent yet)
step("Stream settings");
const logSettings: Json = { full_text_search_keys: { add: ["msg", "text", "error", "reply", "result", "detail"], remove: [] }, index_fields: { add: ["session", "trace_id", "service", "level", "tool", "endpoint", "model", "domain"], remove: [] }, bloom_filter_fields: { add: ["trace_id", "session"], remove: [] } };
if (retention) logSettings.data_retention = retention;
const ls = await call("PUT", `/api/${org}/streams/${logStream}/settings?type=logs`, logSettings, true);
if (ok(ls)) done(`logs stream ${logStream} indexed on session/trace_id/service/level/tool${retention ? `, retention ${retention}d` : ""}`);
else console.log(`  - logs stream settings skipped (${ls.status}; stream not created yet?)`);
const traceSettings: Json = { bloom_filter_fields: { add: ["trace_id", "session_id"], remove: [] }, index_fields: { add: ["session_id", "operation_name", "service_name", "gen_ai_tool_name"], remove: [] } };
if (retention) traceSettings.data_retention = retention;
const ts = await call("PUT", `/api/${org}/streams/default/settings?type=traces`, traceSettings, true);
if (ok(ts)) done(`traces stream indexed on session_id/operation_name/service_name${retention ? `, retention ${retention}d` : ""}`);
else console.log(`  - traces stream settings skipped (${ts.status}; stream not created yet?)`);

// 4. folders
step("Folders");
async function folder(type: "dashboards" | "alerts"): Promise<string> {
  const list = await call("GET", `/api/v2/${org}/folders/${type}`);
  const hit = (list.body?.list ?? []).find((f: Json) => f.name === FOLDER);
  if (hit) {
    done(`${type} folder "${FOLDER}" (${hit.folderId})`);
    return hit.folderId;
  }
  const r = await call("POST", `/api/v2/${org}/folders/${type}`, { name: FOLDER, description: `${BRAND} agent — imported by npm run o2:bootstrap (ADR-0003)` });
  if (!ok(r)) throw new Error(`could not create ${type} folder`);
  done(`${type} folder "${FOLDER}" created (${r.body.folderId})`);
  return r.body.folderId;
}
const dashFolder = await folder("dashboards");
const alertFolder = await folder("alerts");

// 5. dashboards
step("Dashboards");
const fromDisk = existsSync(dashboardsDir) ? readdirSync(dashboardsDir).filter((f) => f.endsWith(".dashboard.json")).sort() : [];
const dashboards: Json[] = fromDisk.length ? fromDisk.map((f) => JSON.parse(readFileSync(join(dashboardsDir, f), "utf8"))) : buildDashboards(METRIC_PREFIX, logStream, BRAND).map((d) => d.dashboard);
if (!fromDisk.length) console.log("  (no JSON on disk — generated in memory; npm run o2:dashboards writes them)");
const existingDash = await call("GET", `/api/${org}/dashboards?folder=${dashFolder}`);
const dashList: Json[] = existingDash.body?.dashboards ?? [];
const dashTitle = (d: Json): string => d.title ?? d.v5?.title ?? d.v4?.title ?? d.v3?.title ?? d.v2?.title ?? d.v1?.title;
const dashId = (d: Json): string | undefined => d.dashboardId ?? d.v5?.dashboardId ?? d.v4?.dashboardId ?? d.v3?.dashboardId ?? d.v2?.dashboardId ?? d.v1?.dashboardId;
const dashboardUrls: string[] = [];
for (const body of dashboards) {
  const found = dashList.find((d) => dashTitle(d) === body.title);
  let id: string | undefined;
  if (found) {
    id = dashId(found);
    let r = await call("PUT", `/api/${org}/dashboards/${id}?folder=${dashFolder}`, { ...body, dashboardId: id }, true);
    if (!ok(r)) {
      // newer servers guard updates with the stored hash — fetch it and retry
      const get = await call("GET", `/api/${org}/dashboards/${id}?folder=${dashFolder}`, undefined, true);
      const hash = get.body?.hash;
      r = await call("PUT", `/api/${org}/dashboards/${id}?folder=${dashFolder}${hash ? `&hash=${encodeURIComponent(hash)}` : ""}`, { ...body, dashboardId: id });
    }
    if (ok(r)) done(`updated  ${body.title}`);
  } else {
    const { dashboardId: _drop, ...fresh } = body;
    const r = await call("POST", `/api/${org}/dashboards?folder=${dashFolder}`, fresh);
    if (ok(r)) {
      id = dashId(r.body) ?? dashId(r.body?.v5 ? r.body : {});
      done(`created  ${body.title}`);
    }
  }
  if (id) dashboardUrls.push(`${body.title}: ${url}/web/dashboards/view?org_identifier=${org}&dashboard=${id}&folder=${dashFolder}`);
}

// 6. template + destination
step("Alert delivery");
const TEMPLATE = `${SERVICE_NAMESPACE}_webhook`;
const DEST = `${SERVICE_NAMESPACE}_webhook`;
const templateBody = JSON.stringify({
  text: "[{alert_level}] {alert_name} — {alert_agg_value} {alert_operator} {alert_threshold} on {stream_name} over {alert_period}m ({alert_count} rows). {alert_description} {alert_url}",
  alert: "{alert_name}",
  level: "{alert_level}",
  stream: "{stream_name}",
  value: "{alert_agg_value}",
  threshold: "{alert_operator} {alert_threshold}",
  period_minutes: "{alert_period}",
  rows: "{alert_count}",
  url: "{alert_url}",
  description: "{alert_description}",
});
const tplExists = ok(await call("GET", `/api/${org}/alerts/templates/${TEMPLATE}`, undefined, true));
const tpl = await call(tplExists ? "PUT" : "POST", `/api/${org}/alerts/templates${tplExists ? `/${TEMPLATE}` : ""}`, { name: TEMPLATE, body: templateBody, type: "http", isDefault: false, title: `${BRAND} webhook` });
if (ok(tpl)) done(`template ${TEMPLATE}`);
// an alert cannot be saved without a destination, so the webhook destination always exists: pointed at
// AGENT_ALERT_WEBHOOK when set, else at a reserved placeholder URL (and the alerts stay disabled)
const PLACEHOLDER = "https://example.com/agent-alerts-unset";
const destExists = ok(await call("GET", `/api/${org}/alerts/destinations/${DEST}`, undefined, true));
const dest = await call(destExists ? "PUT" : "POST", `/api/${org}/alerts/destinations${destExists ? `/${DEST}` : ""}`, { name: DEST, url: webhook || PLACEHOLDER, method: "post", type: "http", template: TEMPLATE, skip_tls_verify: false, headers: {}, output_format: "json" });
const haveDestination = ok(dest) && Boolean(webhook);
if (ok(dest)) done(webhook ? `destination ${DEST} → ${webhook.replace(/(https?:\/\/[^/]+).*/, "$1/…")}` : `destination ${DEST} → placeholder (AGENT_ALERT_WEBHOOK unset; alerts imported disabled)`);

// 7. alerts
step("Alerts");
const alertFiles = existsSync(alertsDir) ? readdirSync(alertsDir).filter((f) => f.endsWith(".alert.json")).sort() : [];
const alerts: Json[] = alertFiles.length ? alertFiles.map((f) => JSON.parse(readFileSync(join(alertsDir, f), "utf8"))) : buildAlerts(METRIC_PREFIX, SERVICE_NAMESPACE).map((a) => a.alert);
const existingAlerts = await call("GET", `/api/v2/${org}/alerts?folder=${alertFolder}`, undefined, true);
const alertList: Json[] = existingAlerts.body?.list ?? existingAlerts.body?.alerts ?? (Array.isArray(existingAlerts.body) ? existingAlerts.body : []);
for (const body of alerts) {
  body.destinations = ok(dest) ? [DEST] : [];
  body.enabled = alertsEnabled && (haveDestination || process.env.O2_ALERTS_ENABLED === "true");
  const found = alertList.find((a) => (a.name ?? a.alert?.name) === body.name);
  const id = found?.alert_id ?? found?.id ?? found?.alert?.id;
  const r = id ? await call("PUT", `/api/v2/${org}/alerts/${id}`, { ...body, id }, true) : await call("POST", `/api/v2/${org}/alerts?folder=${alertFolder}`, body, true);
  if (ok(r)) done(`${id ? "updated" : "created"}  ${body.name}${body.enabled ? "" : " (disabled)"}`);
  else if (r.status === 404 && /stream .* not found/i.test(JSON.stringify(r.body))) console.log(`  - ${body.name}: its metric stream has not received data yet (${body.stream_name}) — re-run the bootstrap after the gateway has exported once`);
  else console.warn(`  ! ${body.name}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
}

console.log(`\nDone. Dashboards: ${url}/web/dashboards?org_identifier=${org}&folder=${dashFolder}`);
for (const u of dashboardUrls) console.log(`  ${u}`);
console.log(`Traces → Sessions: ${url}/web/traces/sessions?org_identifier=${org}   Logs: ${url}/web/logs?org_identifier=${org}&stream=${logStream}`);
