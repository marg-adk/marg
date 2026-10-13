/** preview.test.ts — the draft read off the tool calls: merge vs replace, completion, the summary fingerprint. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PreviewState } from "@marg-adk/types";
import { detectCompletion, detectPreview, draftFingerprint } from "./preview.js";

test("completion: a write tool returning created:true and a real id", () => {
  assert.deepEqual(detectCompletion("create_ticket", JSON.stringify({ created: true, entity_id: "TCK-1", label: "Ticket TCK-1" })), {
    entity_id: "TCK-1",
    entity_url: undefined,
    upload_link: undefined,
    label: "Ticket TCK-1",
  });
  assert.equal(detectCompletion("validate_ticket_slots", JSON.stringify({ created: true, entity_id: "x" })), undefined);
  assert.equal(detectCompletion("create_ticket", "ERROR: refused"), undefined);
  assert.equal(detectCompletion("create_ticket", JSON.stringify({ created: false })), undefined);
});

test("a validate merges onto the prior draft; preview/create replace it; errors advance nothing", () => {
  const first = detectPreview(
    "validate_ticket_slots",
    { title: "Login fails", customer_id: "c1", tags: ["a", "b"] },
    JSON.stringify({ problems: ["category"], from_record: { customer_name: "Northwind" }, defaults: { channel: "email" } }),
    false,
  );
  assert.ok(first);
  assert.equal(first.state, "gathering");
  assert.deepEqual(first.slots, { title: "Login fails", tags: "a, b", channel: "email", customer_name: "Northwind" });
  assert.deepEqual(first.refs, { customer_id: "c1" });
  assert.deepEqual(first.missing, ["category"]);
  assert.deepEqual(first.defaults, ["channel"]);
  assert.deepEqual(first.from_record, ["customer_name"]);

  const second = detectPreview("validate_ticket_slots", { category: "billing" }, JSON.stringify({ problems: [] }), false, first);
  assert.equal(second?.state, "validated");
  assert.equal(second?.slots.title, "Login fails");
  assert.equal(second?.slots.category, "billing");
  assert.deepEqual(second?.defaults, ["channel"]);

  const replaced = detectPreview("preview_ticket", { title: "New" }, JSON.stringify({ ok: true }), false, second);
  assert.deepEqual(replaced?.slots, { title: "New" });

  assert.equal(detectPreview("validate_ticket_slots", { title: "x" }, "ERROR: boom", false, first), undefined);
  assert.equal(detectPreview("validate_ticket_slots", { title: "x" }, "MCP error -32000: closed", false, first), undefined);
  assert.equal(detectPreview("search_customers", { query: "x" }, "{}", false), undefined);
});

test("the summary stays shown only for the draft it was shown for", () => {
  const prior = { tool: "validate_ticket_slots", state: "validated", slots: { title: "x" }, missing: [], summary_shown: true, summary_slots: draftFingerprint({ title: "x" }) } as PreviewState;
  assert.equal(detectPreview("validate_ticket_slots", { title: "x" }, "{}", false, prior)?.summary_shown, true);
  assert.equal(detectPreview("validate_ticket_slots", { title: "y" }, "{}", false, prior)?.summary_shown, undefined);
  assert.equal(draftFingerprint({ title: "x", confirmed: "true" }), draftFingerprint({ title: "x" }));
});
