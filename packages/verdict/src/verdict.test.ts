import { test } from "node:test";
import assert from "node:assert/strict";
import { cascade } from "./cascade.js";
import { llmBackend, probsFromLogprobs } from "./backends/llm.js";
import { mockBackend } from "./backends/mock.js";
import { predicateNoul, regexChoice, regexNoul, rulesBackend } from "./backends/rules.js";
import { systemOneBackend } from "./backends/systemone.js";
import { createSystemOneServer } from "./systemone-server.js";
import { Decider } from "./decider.js";
import { evaluate, fitAbstentionThreshold, fitTemperature, temperatureScale } from "./calibration.js";
import { concentration, type Questions } from "./types.js";

const questions: Questions = {
  department: { type: "choice", instructions: "Which department should handle this message?", criteria: { billing: "payments, invoices, refunds", technical: "bugs, errors, outages", sales: "pricing, plans, upgrades" } },
  urgent: { type: "noul", instructions: "Is the user blocked right now?" },
  severity: { type: "score", instructions: "How severe is the problem?", criteria: ["low", "medium", "high", "critical"] },
};

test("rules answer what they know and stay silent otherwise", async () => {
  const rules = rulesBackend({
    rules: {
      department: regexChoice({ billing: /\b(invoice|refund|charged|payment)\b/i, technical: /\b(error|crash|bug|down)\b/i, sales: /\b(upgrade|pricing|plan)\b/i }),
      urgent: regexNoul(/\b(blocked|cannot work|urgent|asap)\b/i, /\b(no rush|whenever)\b/i),
    },
  });
  const r = await rules.decide({ state: "I was charged twice and I'm blocked", questions });
  assert.equal(r.answers.department.type, "choice");
  assert.equal((r.answers.department as { choice: string }).choice, "billing");
  assert.equal(r.answers.urgent.type, "noul");
  assert.ok((r.answers.urgent as { noul: number }).noul > 0.9);
  assert.equal(r.answers.severity, undefined, "no rule for severity → no opinion");
  const amb = await rules.decide({ state: "a refund for the crash", questions }, ["department"]);
  assert.equal(amb.answers.department, undefined, "two options matched → no opinion");
});

test("cascade escalates unanswered and low-confidence questions, never throws on a dead link", async () => {
  const rules = rulesBackend({ rules: { urgent: predicateNoul((s) => (/blocked/i.test(String(s)) ? true : undefined)) } });
  const dead = { name: "dead", decide: async () => { throw new Error("connection refused"); } };
  const model = mockBackend({ department: "technical", severity: "high" });
  const errors: string[] = [];
  const c = cascade([rules, dead, model], { onError: (b) => errors.push(b) });
  const r = await c.decide({ state: "the app crashes and I'm blocked", questions });
  assert.equal(r.answered_by?.urgent, "rules");
  assert.equal(r.answered_by?.department, "mock");
  assert.equal((r.answers.severity as { level: string }).level, "high");
  assert.deepEqual(errors, ["dead"]);
});

test("cascade keeps a low-confidence earlier answer only as a flagged fallback", async () => {
  const weak = mockBackend({ department: { type: "choice", choice: "sales", probabilities: { billing: 0.34, technical: 0.33, sales: 0.33 }, confidence: 0.01 } });
  const c = cascade([weak], { escalateBelow: 0.5 });
  const r = await c.decide({ state: "x", questions }, ["department"]);
  assert.equal(r.answers.department.low_confidence, true);
});

test("llm backend turns first-token logprobs into a distribution, and a bare letter into an honest one-hot", async () => {
  const withLogprobs = llmBackend({ complete: async () => ({ text: "B", logprobs: { A: -2.3, B: -0.1, C: -3.0 } }) });
  const r = await withLogprobs.decide({ state: "it crashes", questions }, ["department"]);
  const a = r.answers.department as { choice: string; probabilities: Record<string, number>; confidence: number };
  assert.equal(a.choice, "technical");
  assert.ok(a.probabilities.technical > 0.8);
  const bare = llmBackend({ complete: async () => ({ text: "A" }) });
  const r2 = await bare.decide({ state: "x", questions }, ["urgent"]);
  assert.ok((r2.answers.urgent as { noul: number }).noul > 0.5 && (r2.answers.urgent as { confidence: number }).confidence < 0.2, "uncalibrated one-hot is not confident");
  assert.equal(probsFromLogprobs(undefined, []), undefined);
});

test("system one protocol round-trips through the bundled server", async () => {
  const srv = createSystemOneServer({ backend: mockBackend({ department: "billing", urgent: 0.8, severity: "medium" }), apiKey: "k" });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port;
  try {
    const client = systemOneBackend({ url: `http://127.0.0.1:${port}`, apiKey: "k", model: "test" });
    const r = await client.decide({ state: { subject: "invoice", body: "charged twice" }, questions, min_confidence: 0.9 });
    assert.equal((r.answers.department as { choice: string }).choice, "billing");
    assert.equal((r.answers.urgent as { noul: number }).noul, 0.8);
    assert.equal(r.answers.urgent.low_confidence, true, "0.8 → confidence 0.6 < 0.9");
    assert.equal((r.answers.severity as { level: string }).level, "medium");
    const unauth = await fetch(`http://127.0.0.1:${port}/v1/systemone`, { method: "POST", body: "{}" });
    assert.equal(unauth.status, 401);
    const bad = await fetch(`http://127.0.0.1:${port}/v1/systemone`, { method: "POST", headers: { authorization: "Bearer k" }, body: JSON.stringify({ state: "x", questions: { q: { type: "choice", instructions: "?", criteria: { a: "a" } } } }) });
    assert.equal(bad.status, 400, "a choice needs at least two options");
  } finally {
    srv.close();
  }
});

test("decider applies calibration and abstention", async () => {
  const backend = mockBackend({ department: { type: "choice", choice: "billing", probabilities: { billing: 0.5, technical: 0.3, sales: 0.2 }, confidence: concentration({ billing: 0.5, technical: 0.3, sales: 0.2 }) } });
  const q: Questions = { department: questions.department };
  const d = new Decider({ backend, minConfidence: 0.9, calibration: { department: { temperature: 0.3 } } });
  const a = (await d.decide("x", q)).answers.department as { probabilities: Record<string, number> };
  assert.ok(a && a.probabilities.billing > 0.8, "sharpened by T=0.3");
  const soft = new Decider({ backend, minConfidence: 0.9 });
  const b = (await soft.decide("x", q)).answers.department as { abstained?: boolean };
  assert.equal(b?.abstained, true);
  const schema = await new Decider({ backend: mockBackend({ dept: "billing", blocked: 0.9, level: "3" }) }).decideSchema("x", {
    properties: { dept: { enum: ["billing", "sales"] }, blocked: { type: "boolean" }, level: { type: "integer", minimum: 1, maximum: 5 } },
  });
  assert.deepEqual(schema.values, { dept: "billing", blocked: true, level: 3 });
});

test("calibration: temperature fit, ECE and abstention threshold", () => {
  const samples = Array.from({ length: 200 }, (_, i) => {
    const correct = i % 4 !== 0; // 75% accurate
    return { probabilities: { a: correct ? 0.95 : 0.05, b: correct ? 0.05 : 0.95 }, label: "a" };
  });
  const report = evaluate(samples);
  assert.equal(report.n, 200);
  assert.ok(Math.abs(report.accuracy - 0.75) < 0.01);
  assert.ok(report.ece > 0.15, "over-confident model shows a large ECE");
  const T = fitTemperature(samples);
  assert.ok(T > 1, "softening fixes over-confidence");
  assert.ok(evaluate(samples, T).ece < report.ece);
  const sharper = temperatureScale({ a: 0.6, b: 0.4 }, 0.5);
  assert.ok(sharper.a > 0.6);
  assert.equal(fitAbstentionThreshold(samples, 0.99), undefined, "no threshold reaches 99% here");
});
