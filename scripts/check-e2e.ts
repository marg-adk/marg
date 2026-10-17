/**
 * scripts/check-e2e.ts — the real write path, end to end, against a gateway with WRITES ON and the
 * example domain (its backend is a JSON file, so nothing external is touched):
 *   opener → customer pick → category → the Details card → the Priority chips → the summary → yes
 *   → create_ticket runs → completion → a file uploaded AFTER the create attaches at once → the
 *   record on disk has every settled value → history says completed. Then the review path: Change
 *   something → Details with a new Environment → Priority asked again before the summary → the record
 *   on disk is the summary that was confirmed. The proof records are removed.
 *
 *   npm run check:e2e        (scripts/check-e2e.sh boots the gateway on :8791 and runs this)
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../packages/core/src/env.js";

const base = (process.env.EVAL_GATEWAY ?? "http://localhost:8791").replace(/\/+$/, "");
type Json = any;
async function j(path: string, init: RequestInit = {}): Promise<Json> {
  const r = await fetch(base + path, init);
  const t = await r.text();
  try {
    return JSON.parse(t);
  } catch {
    throw new Error(`${path}: HTTP ${r.status} ${t.slice(0, 200)}`);
  }
}
const health = await j("/api/health");
assert.equal(health.writes, true, "this check needs a gateway with AGENT_ALLOW_WRITES=true");
const { session_id } = await j("/api/session", { method: "POST" });
const chat = (sid: string, message: string, display?: string): Promise<Json> => j("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: sid, message, display }) });
const turn = (message: string, display?: string): Promise<Json> => chat(session_id, message, display);
function valueOf(out: Json, label: string): string {
  for (const b of out.ui ?? []) {
    for (const o of b.options ?? []) if (o.label === label) return String(o.value ?? o.label);
    for (const a of b.actions ?? []) if (a.label === label) return String(a.value ?? a.label);
    for (const it of b.items ?? []) if (it.title === label) return String(it.value ?? it.title);
  }
  throw new Error(`no "${label}" on screen: ${JSON.stringify(out.ui)}`);
}

let out = await turn("ticket for Northwind: login fails on mobile");
out = await turn(valueOf(out, "Northwind Traders"));
out = await turn(valueOf(out, "Technical"));
assert.ok((out.ui ?? []).some((b: Json) => b.type === "form"), "the Details card");
out = await turn("Environment [environment]: production; Affected users [affected_users]: 40; Steps to reproduce [steps_to_reproduce]: Open the app, tap login, see a spinner forever", "Details confirmed: Production · 40 users affected");
out = await turn(valueOf(out, "High"));
assert.ok((out.ui ?? []).some((b: Json) => b.type === "card"), "the summary card");
out = await turn(valueOf(out, "Confirm & create ticket"));
const id: string = out.completion?.entity_id;
assert.ok(id, `no completion: ${JSON.stringify(out).slice(0, 400)}`);

// a file uploaded after the create attaches at once
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const up = await j("/api/media", { method: "POST", headers: { "content-type": "image/png", "x-agent-session": session_id, "x-agent-filename": "proof.png" }, body: png });
assert.equal(up.uploaded, true, JSON.stringify(up));
assert.equal(up.attached_to, id);
assert.equal(up.items?.[0]?.attached, true, "attached the moment it landed");

// the record on disk carries every settled value and the attachment
const dataDir = join(REPO_ROOT, "examples", "support-intake", ".data");
const file = join(dataDir, "tickets.json");
const tickets: Json[] = JSON.parse(readFileSync(file, "utf8"));
const t = tickets.find((x) => x.entity_id === id);
assert.ok(t, "the ticket is on disk");
assert.equal(t.customer_name, "Northwind Traders");
assert.equal(t.category, "technical");
assert.equal(t.priority, "high");
assert.equal(t.environment, "production");
assert.equal(t.affected_users, 40);
assert.equal(t.attachments.length, 1);

// history says completed (a reload lands on the finished chat)
const hist = await j(`/api/session/${session_id}/history`);
assert.equal(hist.completed, true);
assert.equal(hist.completion?.entity_id, id);

console.log(`e2e create OK: ${id} — ${t.category}, ${t.priority}, ${t.environment}, ${t.affected_users} users, ${t.attachments.length} attachment; history completed`);

// the review path: a changed Details answer resets Priority (it dependsOn Details), so the runtime asks it
// again BEFORE the summary returns — and the record on disk is the summary the user confirmed
// (the old engine drew the summary over the stale "high" and the write fell back to the tool's default).
const review = (await j("/api/session", { method: "POST" })).session_id as string;
const say = (m: string): Promise<Json> => chat(review, m);
const formReply = (environment: string): string => `Environment [environment]: ${environment}; Affected users [affected_users]: 12; Steps to reproduce [steps_to_reproduce]: Open Billing, export March, the file is empty`;
const kinds = (o: Json): string[] => (o.ui ?? []).map((b: Json) => b.type);
let r = await say("ticket for Contoso: invoice export broken");
await say(valueOf(r, "Billing"));
r = await say(formReply("production"));
r = await say(valueOf(r, "High"));
assert.ok(kinds(r).includes("card"), "the summary card");
r = await say(valueOf(r, "Change something"));
await say(valueOf(r, "Details"));
r = await say(formReply("staging"));
assert.ok(!kinds(r).includes("card"), "no summary over a stale Priority");
assert.ok((r.ui ?? []).some((b: Json) => b.type === "chips" && b.step === "priority"), "Priority is asked again");
r = await say("yes, create it");
assert.ok(!r.completion, "a typed yes beside the open Priority ask writes nothing");
r = await say(valueOf(r, "Low"));
assert.ok((r.ui ?? []).some((b: Json) => b.type === "card" && b.fields?.some((f: Json) => f.key === "priority" && f.value === "low")), "the summary shows the new answer");
r = await say(valueOf(r, "Confirm & create ticket"));
const id2: string = r.completion?.entity_id;
assert.ok(id2, `no completion: ${JSON.stringify(r).slice(0, 400)}`);
const written: Json[] = JSON.parse(readFileSync(file, "utf8"));
const t2 = written.find((x) => x.entity_id === id2);
assert.ok(t2, "the reviewed ticket is on disk");
assert.equal(t2.priority, "low", "the record carries the Priority the user confirmed");
assert.equal(t2.environment, "staging", "the record carries the edited Details");
console.log(`e2e review OK: ${id2} — ${t2.category}, ${t2.priority}, ${t2.environment}: the record is the summary that was confirmed`);

// clean up the proof records and the upload
writeFileSync(file, JSON.stringify(written.filter((x) => x.entity_id !== id && x.entity_id !== id2), null, 2));
const upload = join(dataDir, "uploads", String(t.attachments[0].key));
if (existsSync(upload)) unlinkSync(upload);
console.log("proof records removed");
