/** forms.test.ts — the form wire format, validation and the echo, pinned. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FormBlock, FormRow } from "@marg-adk/types";
import { canonicalPick, formEcho, formReply, looksLikeFormReply, missingRows, parseFormReply, validateFormValues } from "./forms.js";

const rows: FormRow[] = [
  { key: "environment", label: "Environment", kind: "pick", required: true, options: [{ label: "Production", value: "production" }, { label: "Staging", value: "staging" }], say: "{v}" },
  { key: "affected_users", label: "Affected users", kind: "num", say: { one: "1 user", many: "{v} users" } },
  { key: "steps", label: "Steps to reproduce", kind: "area", say: "" },
];
const block = { type: "form", step: "details", title: "Details", rows, echo: "Details confirmed" } as FormBlock;

test("the wire format round-trips; a semicolon in a value never splits a pair", () => {
  const wire = formReply(rows, { environment: "production", affected_users: "12", steps: "open; click" });
  assert.equal(wire, "Environment [environment]: production; Affected users [affected_users]: 12; Steps to reproduce [steps]: open, click");
  assert.equal(looksLikeFormReply(wire), true);
  assert.deepEqual(parseFormReply(wire, rows), { environment: "production", affected_users: "12", steps: "open, click" });
});

test("a typed answer in the same shape parses by label; prose does not parse", () => {
  assert.deepEqual(parseFormReply("Environment: Staging; Affected users: 3", rows), { environment: "Staging", affected_users: "3" });
  assert.equal(parseFormReply("the login page is broken on staging", rows), undefined);
  assert.equal(parseFormReply("Note: staging is down", rows), undefined);
  assert.equal(looksLikeFormReply("hello"), false);
});

test("missing rows, validation against options, canonical picks", () => {
  assert.deepEqual(missingRows(rows, {}).map((r) => r.key), ["environment"]);
  assert.deepEqual(missingRows(rows, { environment: "staging" }), []);
  assert.deepEqual(validateFormValues(rows, { environment: "prod" }), { environment: "Not an option: prod" });
  assert.deepEqual(validateFormValues(rows, { environment: "Staging", affected_users: "12" }), {});
  assert.deepEqual(validateFormValues(rows, { affected_users: "many" }), { affected_users: "Enter a number" });
  assert.equal(canonicalPick(rows[0], "Staging"), "staging");
  assert.equal(canonicalPick(rows[0], "weird"), "weird");
});

test("the echo follows the say templates", () => {
  assert.equal(formEcho(block, { environment: "production", affected_users: "1", steps: "x" }), "Details confirmed: Production · 1 user");
  assert.equal(formEcho(block, { environment: "staging", affected_users: "5" }), "Details confirmed: Staging · 5 users");
  assert.equal(formEcho({ ...block, echo: undefined }, { environment: "staging" }), "Staging");
});
