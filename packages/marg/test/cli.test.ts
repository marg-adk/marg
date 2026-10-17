/** cli.test.ts — CLI flags validation for marg web and marg check. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { run } from "../lib/cli.js";

function captureStd() {
  const err: string[] = [];
  const out: string[] = [];
  const origErr = console.error;
  const origLog = console.log;
  console.error = (...args: any[]) => {
    err.push(args.map(String).join(" "));
  };
  console.log = (...args: any[]) => {
    out.push(args.map(String).join(" "));
  };
  return {
    err,
    out,
    restore() {
      console.error = origErr;
      console.log = origLog;
    },
  };
}

test("marg web: invalid --port values exit 2 and print usage message", async () => {
  const badPorts = ["abc", true, "0", "70000", "-1", "1.5"];
  for (const port of badPorts) {
    const std = captureStd();
    try {
      const code = await run(port === true ? ["web", "--port"] : ["web", "--port", String(port)]);
      assert.equal(code, 2, `expected code 2 for --port ${port}`);
      assert.ok(
        std.err.some((line) => line.includes("marg web: --port must be a whole number from 1 to 65535")),
        `expected error message for --port ${port}`,
      );
      assert.ok(
        std.out.some((line) => line.includes("marg 0.3.0 — the one command for a Marg project")),
        "expected help output on stdout",
      );
    } finally {
      std.restore();
    }
  }
});

test("marg web: invalid --writes values exit 2 and print usage message", async () => {
  const badWrites = ["maybe", "true", "false", "1", ""];
  for (const writes of badWrites) {
    const std = captureStd();
    try {
      const code = await run(["web", "--writes", writes]);
      assert.equal(code, 2, `expected code 2 for --writes ${writes}`);
      assert.ok(
        std.err.some((line) => line.includes('marg web: --writes must be "on" or "off"')),
        `expected error message for --writes ${writes}`,
      );
      assert.ok(
        std.out.some((line) => line.includes("marg 0.3.0 — the one command for a Marg project")),
        "expected help output on stdout",
      );
    } finally {
      std.restore();
    }
  }
});

test("marg check: invalid --port values exit 2 and print usage message", async () => {
  const badPorts = ["abc", true, "0", "70000"];
  for (const port of badPorts) {
    const std = captureStd();
    try {
      const code = await run(port === true ? ["check", "--port"] : ["check", "--port", String(port)]);
      assert.equal(code, 2, `expected code 2 for --port ${port}`);
      assert.ok(
        std.err.some((line) => line.includes("marg check: --port must be a whole number from 1 to 65535")),
        `expected error message for --port ${port}`,
      );
      assert.ok(
        std.out.some((line) => line.includes("marg 0.3.0 — the one command for a Marg project")),
        "expected help output on stdout",
      );
    } finally {
      std.restore();
    }
  }
});
