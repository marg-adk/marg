/**
 * probe/probe.ts — the empirical backend-truth finder for __NAME__ (dev only).
 *
 * Before trusting any API document: build ONE known-good payload, create it, then re-create it
 * with one field stripped at a time to learn the REAL mandatories, the real key spellings and
 * what the server derives. Every record is tagged, every created record is deleted at the end,
 * and the report lands in probe/results/<timestamp>.json — then it is folded into the schema
 * registry as `probe_findings_<date>`.
 *
 *   AGENT_ALLOW_WRITES=true npx tsx domains/__NAME__/probe/probe.ts --yes
 *
 * RULES: refuse without --yes; never probe an unknown route with POST (GET first; a 200 with an
 * id is a write); tag records "PROBE-DELETE-ME"; report what could not be cleaned.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (!process.argv.includes("--yes")) {
  console.error("This creates and deletes REAL records on the dev backend. Re-run with --yes.");
  process.exit(2);
}
const TAG = "PROBE-DELETE-ME";
const known: Record<string, unknown> = { title: `${TAG} probe`, /* every field of a known-good create */ };

async function create(payload: Record<string, unknown>): Promise<{ ok: boolean; id?: string; status: number; body: unknown }> {
  // TODO: POST to your create endpoint with the dev token; return the id when the server answers one
  void payload;
  return { ok: false, status: 0, body: "not implemented" };
}
async function remove(id: string): Promise<boolean> {
  void id;
  return false;
}

const created: string[] = [];
const findings: Record<string, unknown> = { ran_at: new Date().toISOString(), cases: [] as unknown[] };
const base = await create(known);
if (base.id) created.push(base.id);
(findings.cases as unknown[]).push({ case: "known-good", ...base });
for (const field of Object.keys(known)) {
  const { [field]: _omit, ...stripped } = known;
  const r = await create(stripped);
  if (r.id) created.push(r.id);
  (findings.cases as unknown[]).push({ case: `without ${field}`, accepted: r.ok, status: r.status });
}
const leftovers: string[] = [];
for (const id of created) if (!(await remove(id))) leftovers.push(id);
findings.could_not_clean = leftovers;
const out = join(dirname(fileURLToPath(import.meta.url)), "results");
mkdirSync(out, { recursive: true });
const file = join(out, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(file, JSON.stringify(findings, null, 2));
console.log(`report: ${file}${leftovers.length ? `\nCOULD NOT CLEAN: ${leftovers.join(", ")}` : ""}`);
