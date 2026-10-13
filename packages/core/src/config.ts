/**
 * config.ts — the few process-wide settings every module reads.
 *
 * Brand, service namespace and the metric prefix are the only places a product
 * name appears in the runtime; everything else is domain data (manifests, skills,
 * schemas) or environment.
 */
import "./env.js";

/** The product name users see: the prompt identity line, the widget title, degradation messages. */
export const BRAND = process.env.AGENT_BRAND?.trim() || "Marg";

/** `service.namespace` on every span and metric; also the OpenObserve log stream default. */
export const SERVICE_NAMESPACE = (process.env.AGENT_SERVICE_NAMESPACE?.trim() || "marg").toLowerCase().replace(/[^a-z0-9_]+/g, "_");

/** Every metric is `<prefix>_…` so dashboards of two deployments never collide. */
export const METRIC_PREFIX = (process.env.AGENT_METRIC_PREFIX?.trim() || "agent").toLowerCase().replace(/[^a-z0-9_]+/g, "_");

/** `<prefix>_turns_total` etc. */
export const metricName = (suffix: string): string => `${METRIC_PREFIX}_${suffix}`;

/** Attribute namespace on spans: `agent.turn.rounds`, `agent.tool.ok`… */
export const ATTR = "agent";

/** Deployment environment label (local, dev, staging, production). */
export const DEPLOY_ENV = process.env.AGENT_ENV ?? process.env.DEPLOYMENT_ENV ?? "local";

/** Writes to real backends happen only when this is the literal "true". */
export const WRITES_ALLOWED = process.env.AGENT_ALLOW_WRITES === "true";
