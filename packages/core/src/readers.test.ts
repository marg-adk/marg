/** readers.test.ts — the readers the runtime's steps use, pinned. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { allWordsIn, readAmount, readChoice, readNumber, readYesNo } from "./readers.js";

const options = [
  { label: "Billing", value: "billing" },
  { label: "Technical", value: "technical" },
  { label: "Feature request", value: "feature request" },
];

test("readYesNo: yes / no / skip / words by the whole message", () => {
  assert.equal(readYesNo("yes"), "yes");
  assert.equal(readYesNo("nope"), "no");
  assert.equal(readYesNo("skip"), "skip");
  assert.equal(readYesNo("not now"), "skip");
  assert.equal(readYesNo("ok?"), "words");
  assert.equal(readYesNo("yes but make it urgent"), "words");
  assert.equal(readYesNo("create it", ["create"]), "yes");
});

test("readChoice: a value, a label, or the distinctive words of exactly one option", () => {
  assert.equal(readChoice("technical", options).type, "pick");
  assert.deepEqual(readChoice("Billing", options), { type: "pick", value: "billing", option: options[0] });
  assert.deepEqual(readChoice("the billing one please", options), { type: "pick", value: "billing", option: options[0] });
  assert.equal(readChoice("feature", options).type, "pick");
  assert.equal(readChoice("billing or technical?", options).type, "words");
  assert.equal(readChoice("the second one", options).type, "words");
  assert.equal(readChoice("", options).type, "words");
  assert.deepEqual(readChoice("none of these", options, { picking: true }), { type: "none" });
});

test("readNumber: a lone number with an optional unit word", () => {
  assert.equal(readNumber("3"), 3);
  assert.equal(readNumber("3 bathrooms"), 3);
  assert.equal(readNumber("2.5"), 2.5);
  assert.equal(readNumber("make it 3"), undefined);
});

test("readAmount: figures with magnitude words and a basis", () => {
  assert.equal(readAmount("1.8 cr")?.amount, 18_000_000);
  assert.equal(readAmount("85k")?.amount, 85_000);
  assert.equal(readAmount("2,50,000")?.amount, 250_000);
  assert.deepEqual(readAmount("$1,200/mo"), { amount: 1200, unit: undefined, basis: "mo", raw: "$1,200/mo" });
  const r = readAmount("₹45,000 per month");
  assert.equal(r?.amount, 45_000);
  assert.equal(r?.basis, "month");
  assert.equal(readAmount("2 lakh a month")?.amount, 200_000);
  assert.equal(readAmount("no idea"), undefined);
  assert.equal(readAmount("1.5 million", { units: { million: 1e6 } })?.amount, 1_500_000);
});

test("allWordsIn: every word accounted for, or it is content", () => {
  assert.equal(allWordsIn("yes please", ["yes"]), true);
  assert.equal(allWordsIn("yes but no", ["yes"]), false);
});
