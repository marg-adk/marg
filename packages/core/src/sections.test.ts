/** sections.test.ts — the review's section picker and its reader, pinned. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { NOTHING_VALUE, OTHER_VALUE, readEdit, sectionPickerBlock, sectionValue } from "./sections.js";

const sections = [
  { key: "details", label: "Details" },
  { key: "priority", label: "Priority" },
];

test("the picker offers one chip per section plus the ghosts", () => {
  const b = sectionPickerBlock(sections);
  assert.deepEqual(b.options.map((o) => o.label), ["Details", "Priority", OTHER_VALUE, NOTHING_VALUE]);
  assert.equal(b.options[0].value, sectionValue("Details"));
  assert.equal(b.step, "edit");
  assert.equal(sectionPickerBlock(sections, { other: false }).options.length, 3);
});

test("readEdit reads a pick by its whole content", () => {
  assert.deepEqual(readEdit("Edit Priority", sections), { type: "section", section: "priority" });
  assert.deepEqual(readEdit("change the priority", sections), { type: "section", section: "priority" });
  assert.deepEqual(readEdit("priority", sections), { type: "words" }, "a bare noun outside the picker is a remark");
  assert.deepEqual(readEdit("priority", sections, true), { type: "section", section: "priority" });
  assert.deepEqual(readEdit("I want to change something", sections), { type: "menu" });
  assert.deepEqual(readEdit("Nothing to change", sections), { type: "none" });
  assert.deepEqual(readEdit("nothing to change", sections, true), { type: "none" });
  assert.deepEqual(readEdit("Something else", sections, true), { type: "other" });
  assert.deepEqual(readEdit("change the priority to urgent", sections), { type: "words" }, "a value rides along: the model applies it");
  assert.deepEqual(readEdit("change priority and details", sections), { type: "words" }, "two sections");
  assert.deepEqual(readEdit("is the priority right?", sections), { type: "words" });
});
