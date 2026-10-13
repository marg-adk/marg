/** metering.test.ts — the client's contract: batches, idempotent ids, the buffer kept on failure, a fail-open check, drops reported. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { MeteringClient } from "./index.js";

test("batches events, keeps the buffer on failure, fails open on check, reports drops on close", async () => {
  const calls: { url: string; body?: any }[] = [];
  let fail = false;
  const fetchImpl = (async (url: string, init?: { body?: string }) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
    if (fail) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ allowed: false, reason: "cap reached", percent: 100 }) };
  }) as unknown as typeof fetch;
  const dropped: string[] = [];
  const c = new MeteringClient({ baseUrl: "http://metering.test/", apiKey: "k", product: "agent", batchSize: 2, flushMs: 60_000, maxBuffer: 10, onDrop: (evs, reason) => dropped.push(`${reason}:${evs.length}`), fetchImpl });

  c.record({ account_id: "acct", sku: "agent.llm.tokens", quantity: 10, vendor_cost: { amount_micros: 1200, currency: "USD" } });
  assert.equal(c.pending, 1);
  c.record({ account_id: "acct", sku: "agent.llm.tokens", quantity: 5, event_id: "turn-7" });
  await c.flush();
  assert.equal(c.pending, 0);
  assert.equal(calls[0].url, "http://metering.test/v1/events");
  assert.equal(calls[0].body.product, "agent");
  assert.equal(calls[0].body.events.length, 2);
  assert.ok(calls[0].body.events[0].event_id, "an event id is minted when the caller gave none");
  assert.equal(calls[0].body.events[1].event_id, "turn-7");

  fail = true;
  c.record({ account_id: "acct", sku: "agent.stt.audio_seconds", quantity: 3 });
  await c.flush();
  assert.equal(c.pending, 1, "a failed batch goes back to the buffer");
  assert.deepEqual(await c.check("acct"), { allowed: true, reason: "check HTTP 503 (fail-open)" });

  fail = false;
  assert.deepEqual(await c.check("acct"), { allowed: false, reason: "cap reached", percent: 100 });
  assert.equal(calls[calls.length - 1].url, "http://metering.test/v1/check/acct");

  fail = true;
  await c.close(50);
  assert.deepEqual(dropped, ["closed_with_pending:1"]);
  c.record({ account_id: "acct", sku: "x", quantity: 1 });
  assert.equal(c.pending, 0, "a closed client records nothing");
});
