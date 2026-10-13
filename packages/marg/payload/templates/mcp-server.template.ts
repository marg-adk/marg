/**
 * mcp/server.ts — the __NAME__ MCP server: every tool the model (and the gateway) can call.
 *
 *   read-only:  whoami, search_records, reference_data
 *   triad:      validate___ENTITY___slots → preview___ENTITY__ → create___ENTITY__
 *   internal:   add internal_upload_media / internal_attach_media / internal_detach_media for media
 *               (hidden from the model; the gateway calls them — see examples/support-intake)
 *
 * Conventions every domain keeps (docs/PLAYBOOK.md):
 *  - validate_* is write-free and is called after EVERY slot-changing turn; it fills what a record
 *    knows (`from_record`), applies declared defaults (`defaults`) and lists the missing mandatory
 *    slots as `problems`.
 *  - create_* refuses without confirmed:true AND without AGENT_ALLOW_WRITES === "true", and returns
 *    { created: true, entity_id } — the shape that ends the journey. Never weaken either check.
 *  - The user's bearer rides in `_meta` (never in arguments); the trace context in `_meta` joins
 *    this server's spans to the gateway's trace. stdout is the protocol channel: log to stderr.
 *
 * Replace the TODO bodies with calls to your backend. Keep the shapes.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { AUTH_META_KEY, SESSION_META_KEY, extractContext, head, initOtel, log, runInContext, SpanKind, SpanStatusCode, summarize, withSpan } from "@marg-adk/core";

initOtel({ service: "__NAME__-mcp" });

// TODO: your reference data (or fetch it from the backend at boot).
const KINDS = ["a", "b"];
const PRIORITIES = ["low", "high"];
const RECORDS: { record_id: string; name: string }[] = [{ record_id: "rec-1", name: "Example record" }];

const slotSchema = {
  title: z.string().optional().describe("what this is about, short"),
  record_id: z.string().optional().describe("from search_records — never invented"),
  record_name: z.string().optional(),
  kind: z.enum(KINDS as [string, ...string[]]).optional(),
  notes: z.string().optional(),
  priority: z.enum(PRIORITIES as [string, ...string[]]).optional(),
};
type Slots = { [K in keyof typeof slotSchema]?: unknown };

// ---- per-call auth context ------------------------------------------------------------
const auth = new AsyncLocalStorage<{ token?: string; session?: string }>();
const who = (): string => (auth.getStore()?.token ? "user-" + Buffer.from(auth.getStore()!.token!).toString("base64url").slice(0, 6) : "demo-user");

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: `ERROR: ${msg}` }], isError: true });

/** Write-free: what is missing, what the record fills, what defaults apply. TODO: mirror your backend's REAL mandatories (probe/probe.ts). */
function validate(s: Slots): { ok: boolean; problems: string[]; from_record: Record<string, string>; defaults: Record<string, string> } {
  const problems: string[] = [];
  const from_record: Record<string, string> = {};
  const defaults: Record<string, string> = {};
  if (!String(s.title ?? "").trim()) problems.push("title");
  const record = RECORDS.find((r) => r.record_id === s.record_id);
  if (record) from_record.record_name = record.name;
  if (s.kind !== undefined && !KINDS.includes(String(s.kind))) problems.push(`kind must be one of ${KINDS.join(", ")}`);
  if (!s.priority) defaults.priority = "low";
  return { ok: problems.length === 0, problems, from_record, defaults };
}

const server = new McpServer({ name: "__NAME__", version: "0.1.0" });
const register = server.registerTool.bind(server);

/** Register a tool whose handler runs inside the caller's auth context and a SERVER span in the gateway's trace. */
function reg(name: string, cfg: any, handler: (...args: any[]) => any): void {
  register(name, cfg, (async (...args: any[]) => {
    const extra = args[args.length - 1];
    const meta = (extra?._meta ?? {}) as Record<string, unknown>;
    const token = typeof meta[AUTH_META_KEY] === "string" ? (meta[AUTH_META_KEY] as string) : undefined;
    const session = typeof meta[SESSION_META_KEY] === "string" ? (meta[SESSION_META_KEY] as string) : undefined;
    const t0 = Date.now();
    return runInContext(extractContext(meta), () =>
      withSpan(`mcp.tool ${name}`, { kind: SpanKind.SERVER, attrs: { "rpc.system": "mcp", "rpc.service": "__NAME__", "rpc.method": name, "gen_ai.tool.name": name, ...(session ? { "session.id": session } : {}) } }, async (span) => {
        try {
          const out = await auth.run({ token, session }, () => handler(...args));
          const text = out?.content?.[0]?.text ?? "";
          const isOk = !out?.isError && !/^ERROR/.test(text);
          span.setAttributes({ "agent.tool.ok": isOk, "agent.tool.ms": Date.now() - t0 });
          if (!isOk) span.setStatus({ code: SpanStatusCode.ERROR, message: head(text, 200) });
          log.trace("mcp.tool", { session, tool: name, ms: Date.now() - t0, ok: isOk, args: summarize(args.length > 1 ? args[0] : undefined), result: head(text, 300) });
          return out;
        } catch (e) {
          log.trace("mcp.tool", { session, tool: name, ms: Date.now() - t0, ok: false, error: (e as Error).message });
          throw e;
        }
      })
    );
  }) as Parameters<typeof register>[2]);
}

reg("whoami", { description: "The current user's identity. Call once at session start." }, async () => ok({ user_id: who() }));

reg(
  "search_records",
  { description: "Find records by name. Returns ids + names; the model never invents a record_id. 0 matches ⇒ ask the user to re-check the name; 2+ ⇒ let them pick.", inputSchema: { query: z.string().describe("part of the record's name") } },
  async ({ query }: { query: string }) => {
    const q = String(query ?? "").trim().toLowerCase();
    // TODO: call your backend's search here.
    return ok({ records: q ? RECORDS.filter((r) => r.name.toLowerCase().includes(q)) : [] });
  }
);

reg("reference_data", { description: "Option lists: kinds, priorities.", inputSchema: { kind: z.enum(["kinds", "priorities"]) } }, async ({ kind }: { kind: string }) =>
  ok({ kind, options: kind === "kinds" ? KINDS : PRIORITIES })
);

reg(
  "validate___ENTITY___slots",
  { description: "Write-free check of the draft. Call after EVERY turn that adds or changes a slot (it fills the live draft pane). Returns problems (missing/invalid), from_record and defaults.", inputSchema: slotSchema },
  async (args: Slots) => ok(validate(args))
);

reg(
  "preview___ENTITY__",
  { description: "Compose the full payload WITHOUT saving. Send the complete slot set (it replaces the draft).", inputSchema: slotSchema },
  async (args: Slots) => {
    const v = validate(args);
    return v.ok ? ok({ ok: true, payload: { ...args, ...v.from_record, ...v.defaults } }) : ok({ ok: false, problems: v.problems });
  }
);

reg(
  "create___ENTITY__",
  { description: "REAL WRITE — save the __ENTITY__. Only after the user saw the summary and explicitly confirmed; refuses without confirmed:true.", inputSchema: { ...slotSchema, confirmed: z.boolean().describe("true only after the user explicitly confirmed the summary") } },
  async (args: Slots & { confirmed?: boolean }) => {
    if (args.confirmed !== true) return fail("refused: user has not confirmed the summary. Show the summary and ask for an explicit yes first.");
    if (process.env.AGENT_ALLOW_WRITES !== "true") return fail("refused: writes are disabled on this gateway (AGENT_ALLOW_WRITES != true).");
    const v = validate(args);
    if (!v.ok) return fail(`refused: missing or invalid slots — ${v.problems.join("; ")}`);
    // TODO: POST to your backend and return ITS id. Until then a local id keeps the journey runnable.
    const entity_id = "__ENTITY__".slice(0, 3).toUpperCase() + "-" + randomUUID().slice(0, 6).toUpperCase();
    const tmpl = process.env.AGENT_ENTITY_DEEPLINK;
    return ok({ created: true, entity_id, label: `__ENTITY__ ${entity_id}`, entity_url: tmpl ? tmpl.replace("{entity_id}", entity_id) : undefined });
  }
);

await server.connect(new StdioServerTransport());
log.info("__NAME__ MCP ready", { writes: process.env.AGENT_ALLOW_WRITES === "true" });
