/** guards.test.ts — the create gate and the attested-list guard, pinned (the rules that hold for every model). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { attestNote, attestedListGuard, guardCreate, isCreateYes } from "./guards.js";
import type { ChatMessage } from "./llm.js";

test("isCreateYes: a plain go-ahead for the write — never an acknowledgement, a question or a hand-off", () => {
  for (const t of ["yes", "yes, create it", "go ahead", "ok submit it", "confirm", "haan create karo"]) assert.equal(isCreateYes(t), true, t);
  for (const t of ["noted", "good work", "no changes", "let it be", "yes but change the title", "create it later", "the price is right", "done?", "ok?"]) assert.equal(isCreateYes(t), false, t);
});

const history = (last: string): ChatMessage[] => [
  { role: "user", content: "ticket for Northwind" },
  { role: "assistant", content: "Noted." },
  { role: "user", content: last },
];

test("guardCreate refuses before the summary and on anything but a plain yes; non-writes pass", () => {
  assert.equal(guardCreate("create_ticket", history("yes, create it"), true), undefined);
  assert.match(guardCreate("create_ticket", history("yes, create it"), false) ?? "", /has not been shown/);
  assert.match(guardCreate("create_ticket", history("yes but make it urgent"), true) ?? "", /is not a yes/);
  assert.match(guardCreate("create_ticket", history("done?"), true) ?? "", /is not a yes/);
  assert.equal(guardCreate("validate_ticket_slots", history("whatever"), false), undefined);
});

test("attestedListGuard drops list items the user never typed or picked", () => {
  const messages: ChatMessage[] = [{ role: "user", content: "ticket for Northwind, tag it mobile and login" }];
  const args: Record<string, unknown> = { title: "x", tags: ["mobile", "login", "billing"] };
  const out = attestedListGuard("validate_ticket_slots", args, messages, ["tags"]);
  assert.deepEqual(args.tags, ["mobile", "login"]);
  assert.deepEqual(out, [{ key: "tags", removed: ["billing"], kept: ["mobile", "login"] }]);
  assert.match(attestNote(out), /"billing"/);
  const all: Record<string, unknown> = { tags: ["billing"] };
  attestedListGuard("create_ticket", all, messages, ["tags"]);
  assert.equal(all.tags, undefined, "a list with nothing attested is removed");
  assert.deepEqual(attestedListGuard("search_customers", { tags: ["x"] }, messages, ["tags"]), [], "reads are not guarded");
});
