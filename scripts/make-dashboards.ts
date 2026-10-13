/**
 * scripts/make-dashboards.ts — write the starter dashboards and alerts as JSON (npm run o2:dashboards),
 * from the metric prefix, namespace, brand and log stream the runtime is configured with.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BRAND, METRIC_PREFIX, SERVICE_NAMESPACE } from "../packages/core/src/config.js";
import { REPO_ROOT } from "../packages/core/src/env.js";
import { buildAlerts, buildDashboards } from "../observability/openobserve/dashboards.js";

const logStream = process.env.AGENT_O2_LOG_STREAM ?? `${SERVICE_NAMESPACE}_agent`;
const dir = join(REPO_ROOT, "observability", "openobserve");
mkdirSync(join(dir, "dashboards"), { recursive: true });
mkdirSync(join(dir, "alerts"), { recursive: true });
for (const { slug, dashboard } of buildDashboards(METRIC_PREFIX, logStream, BRAND)) {
  writeFileSync(join(dir, "dashboards", `${slug}.dashboard.json`), JSON.stringify(dashboard, null, 2) + "\n");
  console.log(`dashboards/${slug}.dashboard.json  (${(dashboard as { tabs: { panels: unknown[] }[] }).tabs[0].panels.length} panels)`);
}
for (const { name, alert } of buildAlerts(METRIC_PREFIX, SERVICE_NAMESPACE)) {
  writeFileSync(join(dir, "alerts", `${name}.alert.json`), JSON.stringify(alert, null, 2) + "\n");
  console.log(`alerts/${name}.alert.json`);
}
console.log(`prefix ${METRIC_PREFIX}, log stream ${logStream}, brand ${BRAND}`);
