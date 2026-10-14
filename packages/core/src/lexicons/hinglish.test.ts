/** hinglish.test.ts — the Hinglish register loaded: every case the core used to pin, plus the rewrites and question markers it carries. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { isCreateYes } from "../guards.js";
import { isPlainNo, isPlainSkip, isPlainYes, isQuestionShaped, wordsOf } from "../reply-words.js";
import { loadLexicons, loadedLexicons } from "./index.js";

loadLexicons(["hinglish"]);

test("loaded once; an unknown name is an error", () => {
  assert.deepEqual(loadedLexicons(), ["hinglish"]);
  assert.deepEqual(loadLexicons(["hinglish"]), [], "already loaded");
  assert.throws(() => loadLexicons(["klingon"]), /unknown lexicon "klingon"/);
});

test("a plain yes in the register", () => {
  for (const t of ["haan bilkul", "theek hai", "sahi hai bhai", "haan ji", "accha ok", "change nahi karo", "kuch galat nahi hai"]) assert.equal(isPlainYes(t), true, t);
});

test("a plain no in the register", () => {
  for (const t of ["nahi", "nahi bhai", "galat hai", "theek kar do", "isko sahi karo", "na karo"]) assert.equal(isPlainNo(t), true, t);
  for (const t of ["haan", "nahi, create karo"]) assert.equal(isPlainNo(t), false, t);
});

test("questions and unfinished sentences in the register", () => {
  for (const t of ["kya ye sahi hai", "haan ek baat", "theek hai par", "hai na"]) assert.equal(isQuestionShaped(t) || !isPlainYes(t), true, t);
  assert.equal(isQuestionShaped("kya ye sahi hai"), true);
  assert.equal(isQuestionShaped("is ke liye haan"), false, "'is ke liye' is the pronoun, not the English opener");
  assert.equal(isQuestionShaped("are bhai haan"), false, "'are bhai' is an interjection");
});

test("skips and hand-offs in the register", () => {
  for (const t of ["abhi nahi", "not abhi"]) assert.equal(isPlainSkip(t), true, t);
  assert.ok(wordsOf("abhi ke liye theek hai").includes("later"));
  assert.ok(wordsOf("aage badho").includes("proceed"));
  assert.ok(wordsOf("hoga shayad").includes("maybe"));
});

test("the create gate reads the register's go-ahead", () => {
  assert.equal(isCreateYes("haan create karo"), true);
  assert.equal(isCreateYes("haan par pehle ek baat"), false);
});
