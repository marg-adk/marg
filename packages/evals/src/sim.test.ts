/** sim.test.ts — the cooperative user decides from what is on screen: the opener first, forms from answers, preferred taps, asides on cue, stop on a refused write. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { cooperativeUser, type SimView, type TurnResult } from "./index.js";

const turn = (over: Partial<TurnResult>): TurnResult => ({ user: "", reply: "", ui: [], tool_trace: [], ms: 1, ...over });
const view = (n: number, last: TurnResult | undefined, ui: any[] = last?.ui ?? []): SimView => ({ turn: n, last, all: last ? [last] : [], ui, draft: last?.preview ?? null, completed: Boolean(last?.completion) });

test("the opener first, then a form filled from answers in the wire format, leaving a row without an answer empty", async () => {
  const u = cooperativeUser({ opener: "ticket for Contoso: export broken", answers: { environment: "production", steps_to_reproduce: "Export March" } });
  assert.equal(await u.next(view(0, undefined)), "ticket for Contoso: export broken");
  const form = { type: "form", rows: [{ key: "environment", label: "Environment", kind: "pick" }, { key: "affected_users", label: "Affected users", kind: "num" }, { key: "steps_to_reproduce", label: "Steps", kind: "text" }] };
  assert.equal(await u.next(view(1, turn({ reply: "A few details:", ui: [form] }))), "Environment [environment]: production; Steps [steps_to_reproduce]: Export March");
});

test("preferred labels win among chips, list items and card actions; otherwise the first live option; a Confirm action is always preferred", async () => {
  const u = cooperativeUser({ opener: "x", prefer: ["High", "Northwind Traders"] });
  assert.equal(await u.next(view(1, turn({ ui: [{ type: "chips", options: [{ label: "Low", value: "low" }, { label: "High", value: "high" }] }] }))), "high");
  assert.equal(await u.next(view(2, turn({ ui: [{ type: "list", items: [{ title: "Northwind Health", value: "Northwind Health" }, { title: "Northwind Traders", value: "Northwind Traders" }] }] }))), "Northwind Traders");
  assert.equal(await u.next(view(3, turn({ ui: [{ type: "chips", options: [{ label: "More (+3)", value: "more", ghost: true }, { label: "Medium", value: "medium" }] }] }))), "medium", "ghost chips are skipped");
  assert.equal(await u.next(view(4, turn({ ui: [{ type: "card", actions: [{ label: "Change something", value: "change" }, { label: "Confirm & create ticket", value: "yes, create it" }] }] }))), "yes, create it");
});

test("an aside is said once at its turn, the user stops after a refused write or a completion, and after the max", async () => {
  const u = cooperativeUser({ opener: "x", asides: [{ after: 2, say: "what does this mean?" }], max: 5 });
  const chips = { type: "chips", options: [{ label: "A", value: "a" }] };
  assert.equal(await u.next(view(2, turn({ ui: [chips] }))), "what does this mean?");
  assert.equal(await u.next(view(2, turn({ ui: [chips] }))), "a", "the aside is not repeated");
  assert.equal(await u.next(view(3, turn({ reply: "Writes are disabled on this gateway.", ui: [chips] }))), null);
  assert.equal(await u.next(view(3, turn({ completion: { entity_id: "T-1" } as any, ui: [chips] }))), null);
  assert.equal(await u.next(view(3, turn({ reply: "Noted." }))), null, "nothing on screen: nothing more to say");
  assert.equal(u.max, 5);
});
