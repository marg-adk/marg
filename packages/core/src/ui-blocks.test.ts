/** ui-blocks.test.ts — tolerant block parsing, the safety pass, dedupe, summary rows. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { dedupeBlocks, dedupeSentences, extractUiBlocks, humanise, linkAllowed, rowsFromSlots, sanitizeUi, visibleSoFar } from "./ui-blocks.js";

const chips = '{"type":"chips","options":[{"label":"A"},{"label":"B"}]}';

test("well-formed blocks come out structured; the prose stays clean", () => {
  const { clean, ui } = extractUiBlocks("Pick one:\n```ui\n" + chips + "\n```\nThanks");
  assert.equal(clean, "Pick one:\n\nThanks");
  assert.equal(ui.length, 1);
  assert.equal((ui[0] as { type: string }).type, "chips");
});

test("tolerant of what models really emit around a block", () => {
  assert.equal(extractUiBlocks("```ui\n" + chips + "\n```][").ui.length, 1, "junk glued to the closing fence");
  assert.equal(extractUiBlocks("Here\n```ui\n" + chips).ui.length, 1, "never closed");
  assert.equal(extractUiBlocks("Here\n```ui\n" + chips + "\n``").ui.length, 1, "closed with two backticks");
  assert.equal(extractUiBlocks("```ui " + chips + " ```").ui.length, 1, "one line");
  const bare = extractUiBlocks("Sure.\n" + chips);
  assert.equal(bare.ui.length, 1, "no fence at all");
  assert.equal(bare.clean, "Sure.");
  assert.equal(extractUiBlocks("```ui\n{not json\n```").ui.length, 0, "malformed is dropped, never thrown");
});

test("while streaming, an open block and a trailing partial fence are held back", () => {
  assert.equal(visibleSoFar("Hello ``"), "Hello");
  assert.equal(visibleSoFar('Hello\n```ui\n{"type":'), "Hello");
  assert.equal(visibleSoFar("Hello\n```ui\n" + chips + "\n```\nmore"), "Hello\n\nmore");
});

test("sanitizeUi: link schemes, lone chips, string values, caps", () => {
  const out = sanitizeUi([
    { type: "link", label: "x", url: "javascript:alert(1)" },
    { type: "link", label: "Open", url: "https://example.com/t/1" },
    { type: "chips", options: [{ label: "Only one" }] },
    { type: "chips", options: [{ label: "A", value: 1 }, { label: "B" }] },
    { type: "list", items: [] },
    { type: "card" },
  ]) as Record<string, unknown>[];
  assert.deepEqual(out.map((b) => b.type), ["link", "chips", "card"]);
  assert.deepEqual((out[1].options as { value: string }[]).map((o) => o.value), ["1", "B"]);
  assert.deepEqual(out[2].fields, []);
  assert.equal(sanitizeUi(Array.from({ length: 6 }, () => ({ type: "card", fields: [] }))).length, 4);
  assert.equal(linkAllowed("https://example.com"), true);
  assert.equal(linkAllowed("data:text/html,hi"), false);
});

test("dedupe: a sentence re-emitted after a tool; identical blocks", () => {
  assert.equal(dedupeSentences("I found a match. I found a match. Next?"), "I found a match. Next?");
  assert.equal(dedupeBlocks([{ type: "card" }, { type: "card" }, { type: "chips" }]).length, 2);
});

test("rowsFromSlots: order, labels, defaults, hidden plumbing", () => {
  const rows = rowsFromSlots(
    { title: "Login fails", customer_id: "c1", channel: "email", confirmed: "true", priority: "high" },
    { labels: { title: "Title" }, defaults: ["channel"], order: ["priority", "title"] },
  );
  assert.deepEqual(
    rows.map((r) => [r.key, r.label, r.value, r.source]),
    [["priority", "Priority", "high", "user"], ["title", "Title", "Login fails", "user"], ["channel", "Channel", "email (default)", "default"]],
  );
  assert.equal(humanise("sale_price"), "Sale price");
});
