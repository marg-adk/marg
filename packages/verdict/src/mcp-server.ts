/**
 * mcp-server.ts — Verdict as an MCP tool server (stdio), for any agent that speaks MCP.
 *
 * Tools: `decide` (state + questions → answers), `verdict_status`. Backends from the environment
 * (VERDICT_SYSTEMONE_URL …). stdout is the protocol channel: log with console.error only.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { deciderFromEnv, verdictEnvSnapshot } from "./env.js";
import type { Questions } from "./types.js";

const { decider, links } = deciderFromEnv();
const server = new McpServer({ name: "marg-verdict", version: "0.1.0" });
const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });

server.registerTool(
  "decide",
  {
    description: "Answer typed questions about a state with calibrated probabilities: choice (pick one of named options), noul (yes/no → P(true)), score (ordinal levels). Use for routing, classification, checks — never for prose.",
    inputSchema: {
      state: z.union([z.string(), z.record(z.unknown()), z.array(z.unknown())]).describe("The text or object to judge"),
      questions: z.record(z.object({ type: z.enum(["noul", "choice", "score"]), instructions: z.string(), criteria: z.union([z.record(z.string()), z.array(z.string())]).optional() })).describe("Named questions"),
      min_confidence: z.number().min(0).max(1).optional(),
    },
  },
  async (args) => {
    const res = await decider.decide(args.state as never, args.questions as Questions, { min_confidence: args.min_confidence });
    return ok(res);
  }
);

server.registerTool("verdict_status", { description: "Which decision backends are configured." }, async () => ok({ links, env: verdictEnvSnapshot() }));

await server.connect(new StdioServerTransport());
console.error(`[verdict-mcp] ready — backends: ${links.join(" → ") || "none"}`);
