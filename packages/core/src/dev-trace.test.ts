/** dev-trace.test.ts — the dev trace collects a turn's facts only when AGENT_DEV_TRACE is "true", masks secrets, bounds what it keeps. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentReply } from "@marg-adk/types";

// keepTurn persists the session: keep the files out of the repository's .sessions
const dir = mkdtempSync(join(tmpdir(), "marg-dev-trace-"));
process.env.AGENT_SESSION_DIR = dir;
const { KEEP_TURNS, beginTrace, endTrace, keepTurn, traceLlm, traceStep, traceTool } = await import("./dev-trace.js");
type Session = Parameters<typeof beginTrace>[0];

const fakeSession = (id: string): Session => ({ id, messages: [], createdAt: Date.now(), usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, calls: 0, turns: 0 }, shared: {} });
const withFlag = async (on: boolean, fn: () => void | Promise<void>): Promise<void> => {
  const before = process.env.AGENT_DEV_TRACE;
  process.env.AGENT_DEV_TRACE = on ? "true" : "false";
  try {
    await fn();
  } finally {
    if (before === undefined) delete process.env.AGENT_DEV_TRACE;
    else process.env.AGENT_DEV_TRACE = before;
  }
};

test("off (anything but the literal true): nothing is collected, nothing is kept", async () => {
  await withFlag(false, () => {
    const s = fakeSession("off-1");
    beginTrace(s, 1, { domain: "d", by: "single" });
    traceStep(s, "details", "drawn", "moment");
    traceTool(s, { name: "t", args: { q: "x" }, result: "r", ms: 1 });
    traceLlm(s, { round: 0, ms: 1, input: 1, output: 1, finish: "stop" });
    assert.equal(endTrace(s), undefined);
    keepTurn(s, { user: "hi", ms: 5, out: { reply: "x", ui: [], tool_trace: [] } as AgentReply });
    assert.equal(s.turns, undefined);
  });
  const before = process.env.AGENT_DEV_TRACE;
  process.env.AGENT_DEV_TRACE = "1";
  try {
    const s = fakeSession("off-2");
    beginTrace(s, 1);
    assert.equal(endTrace(s), undefined, '"1" is not "true"');
  } finally {
    if (before === undefined) delete process.env.AGENT_DEV_TRACE;
    else process.env.AGENT_DEV_TRACE = before;
  }
});

test("on: the route, steps, tool calls and model calls of one turn, in order, and the trace ends with the turn", async () => {
  await withFlag(true, () => {
    const s = fakeSession("on-1");
    beginTrace(s, 4, { domain: "support-intake", by: "keywords", confidence: 0.53 });
    traceStep(s, "details", "redrawn", "moment");
    traceStep(s, "confirm", "summary");
    traceTool(s, { name: "search_customers", args: { query: "Northwind" }, result: '{"customers":[]}', ms: 3, ok: true, carried: ["customer_id"] });
    traceLlm(s, { round: 0, endpoint: "mock", model: "mock", ms: 12, ttft_ms: 4, input: 100, output: 7, finish: "tool_calls" });
    const t = endTrace(s)!;
    assert.equal(t.turn, 4);
    assert.deepEqual(t.route, { domain: "support-intake", by: "keywords", confidence: 0.53 });
    assert.deepEqual(t.steps, [{ step: "details", event: "redrawn", via: "moment" }, { step: "confirm", event: "summary" }]);
    assert.deepEqual(t.tools, [{ name: "search_customers", args: { query: "Northwind" }, result: '{"customers":[]}', ms: 3, ok: true, carried: ["customer_id"] }]);
    assert.equal(t.llm[0].ttft_ms, 4);
    assert.equal(endTrace(s), undefined, "ended");
    traceStep(s, "late", "drawn");
    assert.equal(endTrace(s), undefined, "hooks after the end collect nothing");
  });
});

test("on: secrets and phone numbers are masked, long text is clipped with its length", async () => {
  await withFlag(true, () => {
    const s = fakeSession("on-2");
    beginTrace(s, 1);
    traceTool(s, { name: "lookup", args: { api_key: "sk-live-abc", note: "call +49 170 1234567 now", steps: "x".repeat(900) }, result: `phone 9876543210 ${"y".repeat(2500)}`, ms: 1 });
    const [call] = endTrace(s)!.tools;
    const args = call.args as Record<string, string>;
    assert.equal(args.api_key, "[redacted]");
    assert.match(args.note, /\[phone\]/);
    assert.doesNotMatch(args.note, /1234567/);
    assert.match(args.steps, /\(900 chars\)$/);
    assert.match(call.result, /^phone \[phone\] /);
    assert.match(call.result, /… \(\d+ chars\)$/);
    assert.ok(call.result.length < 2100);
  });
});

test("keepTurn keeps the last KEEP_TURNS turns on the session and writes them down", async () => {
  await withFlag(true, () => {
    const s = fakeSession("keep-1");
    for (let n = 1; n <= KEEP_TURNS + 5; n++) {
      beginTrace(s, n, { domain: "d", by: "single" });
      const trace = endTrace(s)!;
      keepTurn(s, { user: `message ${n} ${"z".repeat(500)}`, display: n === 1 ? "shown" : undefined, ms: n, out: { reply: "", ui: [], tool_trace: [{ tool: "runtime:x", ms: 1 }], domain: "d", kind: "x", trace } as AgentReply });
    }
    assert.equal(s.turns!.length, KEEP_TURNS);
    assert.equal(s.turns![0].turn, 6, "the oldest five fell off");
    assert.equal(s.turns!.at(-1)!.turn, KEEP_TURNS + 5);
    assert.ok(s.turns![0].user.length < 330, "the user text is clipped");
    const file = join(dir, "keep-1.json");
    assert.ok(existsSync(file), "persisted with the session");
    assert.equal(JSON.parse(readFileSync(file, "utf8")).turns.length, KEEP_TURNS);
    const bare = fakeSession("keep-2");
    keepTurn(bare, { user: "no trace on the reply", ms: 1, out: { reply: "", ui: [], tool_trace: [] } as AgentReply });
    assert.equal(bare.turns, undefined, "a reply without a trace is not kept");
  });
});
