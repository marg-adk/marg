/** forms.test.ts — the form wire format, validation and the echo, pinned. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FormBlock, FormRow } from "@marg-adk/types";
import { canonicalPick, formEcho, formReply, looksLikeFormReply, missingRows, parseFormReply, validateFormValues, isIsoDay } from "./forms.js";

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

test("date rows: the ISO day shape and a real calendar day, nothing else", () => {
  const rows = [{ key: "date", label: "Date", kind: "date" as const, required: true }];
  assert.deepEqual(validateFormValues(rows, { date: "2026-11-06" }), {});
  assert.equal(validateFormValues(rows, { date: "6 Nov" }).date, "Enter a date as YYYY-MM-DD");
  assert.equal(validateFormValues(rows, { date: "2026-02-31" }).date, "Enter a date as YYYY-MM-DD");
  assert.equal(validateFormValues(rows, { date: "2026-13-01" }).date, "Enter a date as YYYY-MM-DD");
  assert.ok(isIsoDay("2024-02-29") && !isIsoDay("2023-02-29"));
});
