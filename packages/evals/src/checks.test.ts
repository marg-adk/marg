/** checks.test.ts — the dev-trace checks say what they claim: a route of one domain needs no confidence, a list of links matches any, a reload must hold the same trace. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { hasTrace, reloadKeepsTrace, routeIs, stepEvent, toolCall, type DevTrace, type TurnResult } from "./index.js";

const trace = (over: Partial<DevTrace> = {}): DevTrace => ({
  turn: 1,
  route: { domain: "support-intake", by: "keywords", confidence: 0.53 },
  steps: [{ step: "details", event: "late_draw", via: "late" }],
  tools: [{ name: "search_customers", args: { query: "Northwind", confirmed: true }, result: '{"customers":[{"name":"Northwind Traders"},{"name":"Northwind Health"}]}', ms: 3, ok: true }],
  llm: [],
  ...over,
});
const turn = (t?: DevTrace, turns?: TurnResult["turns"]): TurnResult => ({ user: "x", reply: "", ui: [], tool_trace: [], ms: 1, trace: t, turns });
const passes = (c: { pass: (t: TurnResult, all: TurnResult[]) => boolean }, t: TurnResult): boolean => c.pass(t, [t]);

test("hasTrace: present or not", () => {
  assert.equal(passes(hasTrace, turn(trace())), true);
  assert.equal(passes(hasTrace, turn(undefined)), false);
});

test("routeIs: domain, one link or any of a list, a confidence in (0, 1] — and a single-domain route needs none", () => {
  const t = turn(trace());
  assert.equal(passes(routeIs({ domain: "support-intake", by: "keywords", confidence: true }), t), true);
  assert.equal(passes(routeIs({ domain: "bookings" }), t), false);
  assert.equal(passes(routeIs({ by: "llm" }), t), false);
  assert.equal(passes(routeIs({ by: ["keywords", "single"], confidence: true }), t), true);
  assert.equal(passes(routeIs({ confidence: true }), turn(trace({ route: { domain: "d", by: "keywords" } }))), false, "a keywords route without a confidence");
  assert.equal(passes(routeIs({ confidence: true }), turn(trace({ route: { domain: "d", by: "keywords", confidence: 1.4 } }))), false, "out of range");
  const single = turn(trace({ route: { domain: "support-intake", by: "single" } }));
  assert.equal(passes(routeIs({ domain: "support-intake", by: ["keywords", "single"], confidence: true }), single), true, "one domain installed: no decision, no confidence");
  assert.equal(passes(routeIs({ by: "keywords", confidence: true }), single), false, "but a gateway that must route by keywords says so");
  assert.equal(passes(routeIs({}), turn(trace({ route: undefined }))), false, "no route at all");
});

test("stepEvent and toolCall: the step's event this turn; the call's arguments (strings exactly, regexes by test) and result", () => {
  const t = turn(trace());
  assert.equal(passes(stepEvent("details", "late_draw"), t), true);
  assert.equal(passes(stepEvent("details", "settled"), t), false);
  assert.equal(passes(stepEvent("priority", "late_draw"), t), false);
  assert.equal(passes(toolCall("search_customers", { args: { query: /North/ }, result: /Northwind Traders/ }), t), true);
  assert.equal(passes(toolCall("search_customers", { args: { query: "Northwind", confirmed: "true" } }), t), true, "a boolean argument compares as its text");
  assert.equal(passes(toolCall("search_customers", { args: { query: "South" } }), t), false);
  assert.equal(passes(toolCall("search_customers", { result: /Contoso/ }), t), false);
  assert.equal(passes(toolCall("create_ticket"), t), false);
});

test("reloadKeepsTrace: the history's turns hold this turn's trace unchanged", () => {
  const t = trace();
  assert.equal(passes(reloadKeepsTrace, turn(t, [{ turn: 1, trace: JSON.parse(JSON.stringify(t)) }])), true);
  assert.equal(passes(reloadKeepsTrace, turn(t, [{ turn: 1, trace: trace({ steps: [] }) }])), false, "a trace that changed");
  assert.equal(passes(reloadKeepsTrace, turn(t, [{ turn: 2, trace: t }])), false, "another turn's");
  assert.equal(passes(reloadKeepsTrace, turn(t, undefined)), false, "no turns in the history (the flag is off, or the replay is missing)");
});
