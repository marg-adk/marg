/** reply-words.test.ts — the whole-content rule, pinned, for the English core. The Hinglish register has its own suite (lexicons/hinglish.test.ts). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { extendLexicon, isPlainNo, isPlainSkip, isPlainYes, isQuestionShaped, wordsOf } from "./reply-words.js";

test("a plain yes: confirm words, politeness and fillers only", () => {
  for (const t of ["yes", "Yes please", "ok go ahead", "👍", "sure, proceed", "correct", "yes, that's right", "nothing to change", "no changes needed", "looks good"]) {
    assert.equal(isPlainYes(t), true, t);
  }
});

test("read by the whole content: a yes beside anything else is words", () => {
  for (const t of ["yes but change the price to 50", "ok, keep it private please", "yes create it later", "no, create it", "yes? are you sure", "yes and", "I'll confirm later", "keep this private"]) {
    assert.equal(isPlainYes(t), false, t);
  }
});

test("a plain no: refusal words and fillers only", () => {
  for (const t of ["no", "nope", "not right", "change it", "no, that's wrong", "let me change it", "wait"]) assert.equal(isPlainNo(t), true, t);
  for (const t of ["no, create it", "no change needed", "no but the price is fine", "yes"]) assert.equal(isPlainNo(t), false, t);
});

test("a skip", () => {
  for (const t of ["skip", "skip this", "later", "skip for now", "not now"]) assert.equal(isPlainSkip(t), true, t);
  assert.equal(isPlainSkip("skip the deposit and set rent 50k"), false);
});

test("a question or an unfinished sentence is never a bare answer", () => {
  for (const t of ["is it created?", "ok so", "yes one thing", "can we change the price"]) assert.equal(isQuestionShaped(t), true, t);
  assert.equal(isQuestionShaped("yes"), false);
  assert.equal(isQuestionShaped("ok?"), true, "a lone word with a question mark asks something");
  assert.equal(isPlainYes("yes, is it done?"), false);
});

test("strict: acknowledgements and praise are not a go-ahead on their own", () => {
  assert.equal(isPlainYes("noted"), true);
  assert.equal(isPlainYes("noted", [], { strict: true }), false);
  assert.equal(isPlainYes("yes, noted", [], { strict: true }), true);
});

test("a question's own go-ahead words count only when passed in", () => {
  assert.equal(isPlainYes("create it"), false);
  assert.equal(isPlainYes("create it", ["create"]), true);
});

test("wordsOf: hand-offs, negated changes and emoji read as what they mean", () => {
  assert.deepEqual(wordsOf("No changes needed 👍"), ["ok", "yes"]);
  assert.ok(wordsOf("I'll confirm later").includes("later"));
  assert.deepEqual(wordsOf("go ahead"), ["proceed"]);
});

test("extendLexicon adds a register (last — it widens the lexicon for the process)", () => {
  assert.equal(isPlainYes("oui"), false);
  extendLexicon({ confirm: ["oui"] });
  assert.equal(isPlainYes("oui"), true);
});

test("the English core knows no register until one is loaded", () => {
  for (const t of ["haan bilkul", "theek hai"]) assert.equal(isPlainYes(t), false, t);
  assert.equal(isPlainNo("nahi"), false);
});
