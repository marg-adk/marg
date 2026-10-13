/**
 * server.ts — the support-intake MCP server: the smallest honest example of a domain tool surface.
 *
 * It implements the naming triad against a local JSON file instead of a real backend, so the
 * whole platform runs end to end with zero external services:
 *
 *   read-only:  whoami, search_customers, reference_data, get_my_tickets
 *   triad:      validate_ticket_slots → preview_ticket → create_ticket
 *   internal:   internal_upload_media, internal_attach_media, internal_detach_media (gateway-only)
 *
 * The conventions a real domain keeps:
 *  - validate_* is write-free, called after EVERY slot-changing turn (it feeds the live draft pane),
 *    fills what a record knows (`from_record`), applies declared defaults (`defaults`) and returns
 *    the missing mandatory slots as `problems`.
 *  - create_* refuses without confirmed:true AND without AGENT_ALLOW_WRITES === "true" (the write
 *    gate ×3; never weaken either), and returns { created:true, entity_id } — the shape that ends the chat.
 *  - The user's bearer token rides in `_meta` (never in arguments) and is bound per call with
 *    AsyncLocalStorage; the trace context in `_meta` joins the child's spans to the gateway's trace.
 *  - stdout is the protocol channel: the logger writes to stderr (AGENT_LOG_TO_STDERR is set by the spawner).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { AUTH_META_KEY, SESSION_META_KEY, extractContext, head, initOtel, log, runInContext, SpanKind, SpanStatusCode, summarize, withSpan } from "@marg/core";

initOtel({ service: "marg-support-intake-mcp" });

const DIR = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(DIR, "..", ".data");
const TICKETS = join(DATA_DIR, "tickets.json");
const UPLOADS = join(DATA_DIR, "uploads");
const CUSTOMERS = JSON.parse(await readFile(join(DIR, "..", "fixtures", "customers.json"), "utf8")) as { customer_id: string; name: string; plan: string; city: string }[];

const CATEGORIES = ["billing", "technical", "account", "feature request"];
const PRIORITIES = ["low", "medium", "high", "urgent"];
const CHANNELS = ["email", "phone", "chat"];
const ENVIRONMENTS = ["production", "staging", "local"];

interface Ticket {
  entity_id: string;
  title: string;
  customer_id: string;
  customer_name: string;
  category: string;
  priority: string;
  channel: string;
  environment?: string;
  affected_users?: number;
  steps_to_reproduce?: string;
  tags?: string[];
  attachments: { key: string; kind: string; label?: string; cover?: boolean }[];
  created_at: string;
  created_by?: string;
}

// ---- per-call auth context ------------------------------------------------------------
const auth = new AsyncLocalStorage<{ token?: string; session?: string }>();
const who = () => auth.getStore()?.token ? "user-" + Buffer.from(auth.getStore()!.token!).toString("base64url").slice(0, 6) : "demo-user";

const slotSchema = {
  title: z.string().optional().describe("what went wrong, short"),
  customer_id: z.string().optional().describe("from search_customers — never invented"),
  customer_name: z.string().optional(),
  category: z.enum(CATEGORIES as [string, ...string[]]).optional(),
  priority: z.enum(PRIORITIES as [string, ...string[]]).optional(),
  channel: z.enum(CHANNELS as [string, ...string[]]).optional(),
  environment: z.enum(ENVIRONMENTS as [string, ...string[]]).optional(),
  affected_users: z.union([z.number(), z.string()]).optional(),
  steps_to_reproduce: z.string().optional(),
  tags: z.array(z.string()).optional(),
};
type Slots = { [K in keyof typeof slotSchema]?: unknown };

async function loadTickets(): Promise<Ticket[]> {
  try {
    return JSON.parse(await readFile(TICKETS, "utf8")) as Ticket[];
  } catch {
    return [];
  }
}
async function saveTickets(t: Ticket[]): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(TICKETS, JSON.stringify(t, null, 2));
}

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: `ERROR: ${msg}` }], isError: true });

/** Validate the draft: fill from the customer record, apply defaults, list what is missing. Write-free. */
function validate(s: Slots): { ok: boolean; problems: string[]; from_record: Record<string, string>; defaults: Record<string, string>; conflicts?: string[] } {
  const problems: string[] = [];
  const from_record: Record<string, string> = {};
  const defaults: Record<string, string> = {};
  if (!String(s.title ?? "").trim()) problems.push("title");
  const customer = CUSTOMERS.find((c) => c.customer_id === s.customer_id);
  if (!customer) problems.push("customer_id (resolve the customer with search_customers)");
  else {
    from_record.customer_name = customer.name;
    from_record.plan = customer.plan;
    from_record.city = customer.city;
  }
  if (!s.category) problems.push("category");
  else if (!CATEGORIES.includes(String(s.category))) problems.push(`category must be one of ${CATEGORIES.join(", ")}`);
  if (!s.channel) defaults.channel = "email";
  if (s.affected_users !== undefined && !/^\d+$/.test(String(s.affected_users).trim())) problems.push("affected_users must be a whole number");
  return { ok: problems.length === 0, problems, from_record, defaults };
}

const server = new McpServer({ name: "support-intake", version: "0.1.0" });
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
      withSpan(`mcp.tool ${name}`, { kind: SpanKind.SERVER, attrs: { "rpc.system": "mcp", "rpc.service": "support-intake", "rpc.method": name, "gen_ai.tool.name": name, ...(session ? { "session.id": session } : {}) } }, async (span) => {
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

reg("whoami", { description: "The current user's identity. Call once at session start." }, async () => ok({ user_id: who(), name: "Demo agent" }));

reg(
  "search_customers",
  { description: "Find customers by name (case-insensitive substring). Returns ids + names; the model never invents a customer_id. 0 matches ⇒ ask the user to re-check the name; 2+ ⇒ let them pick.", inputSchema: { query: z.string().describe("part of the customer's name") } },
  async ({ query }: { query: string }) => {
    const q = String(query ?? "").trim().toLowerCase();
    const hits = q ? CUSTOMERS.filter((c) => c.name.toLowerCase().includes(q)) : [];
    return ok({ customers: hits.map((c) => ({ customer_id: c.customer_id, name: c.name, plan: c.plan, city: c.city })) });
  }
);

reg("reference_data", { description: "Option lists: categories, priorities, channels, environments.", inputSchema: { kind: z.enum(["categories", "priorities", "channels", "environments"]) } }, async ({ kind }: { kind: string }) =>
  ok({ kind, options: kind === "categories" ? CATEGORIES : kind === "priorities" ? PRIORITIES : kind === "channels" ? CHANNELS : ENVIRONMENTS })
);

reg("get_my_tickets", { description: "The user's tickets, newest first." }, async () => ok({ tickets: (await loadTickets()).filter((t) => t.created_by === who()).slice(-20).reverse() }));

reg(
  "validate_ticket_slots",
  { description: "Write-free check of the draft ticket. Call after EVERY turn that adds or changes a slot (it fills the live draft pane). Returns problems (missing/invalid), from_record (filled from the customer) and defaults.", inputSchema: slotSchema },
  async (args: Slots) => ok(validate(args))
);

reg(
  "preview_ticket",
  { description: "Compose the full ticket payload WITHOUT saving. Send the complete slot set (it replaces the draft).", inputSchema: slotSchema },
  async (args: Slots) => {
    const v = validate(args);
    if (!v.ok) return ok({ ok: false, problems: v.problems });
    return ok({ ok: true, payload: { ...args, ...v.from_record, ...v.defaults } });
  }
);

reg(
  "create_ticket",
  { description: "REAL WRITE — save the ticket. Only after the user saw the summary and explicitly confirmed; refuses without confirmed:true.", inputSchema: { ...slotSchema, confirmed: z.boolean().describe("true only after the user explicitly confirmed the summary") } },
  async (args: Slots & { confirmed?: boolean }) => {
    if (args.confirmed !== true) return fail("refused: user has not confirmed the summary. Show the summary and ask for an explicit yes first.");
    if (process.env.AGENT_ALLOW_WRITES !== "true") return fail("refused: writes are disabled on this gateway (AGENT_ALLOW_WRITES != true).");
    const v = validate(args);
    if (!v.ok) return fail(`refused: missing or invalid slots — ${v.problems.join("; ")}`);
    const customer = CUSTOMERS.find((c) => c.customer_id === args.customer_id)!;
    const ticket: Ticket = {
      entity_id: "TCK-" + randomUUID().slice(0, 6).toUpperCase(),
      title: String(args.title).trim(),
      customer_id: customer.customer_id,
      customer_name: customer.name,
      category: String(args.category),
      priority: PRIORITIES.includes(String(args.priority)) ? String(args.priority) : "medium",
      channel: CHANNELS.includes(String(args.channel)) ? String(args.channel) : "email",
      environment: args.environment ? String(args.environment) : undefined,
      affected_users: args.affected_users !== undefined ? Number(args.affected_users) : undefined,
      steps_to_reproduce: args.steps_to_reproduce ? String(args.steps_to_reproduce).slice(0, 2000) : undefined,
      tags: Array.isArray(args.tags) ? args.tags.map(String).slice(0, 10) : undefined,
      attachments: [],
      created_at: new Date().toISOString(),
      created_by: who(),
    };
    const all = await loadTickets();
    all.push(ticket);
    await saveTickets(all);
    const tmpl = process.env.AGENT_ENTITY_DEEPLINK;
    return ok({ created: true, entity_id: ticket.entity_id, label: `Ticket ${ticket.entity_id}`, status: "open", entity_url: tmpl ? tmpl.replace("{entity_id}", ticket.entity_id) : undefined });
  }
);

// ---- gateway-only media tools (hidden from the model) ------------------------------------
reg(
  "internal_upload_media",
  { description: "Gateway-only: store an uploaded file (bytes arrive as a temp file path).", inputSchema: { kind: z.string(), file_path: z.string(), filename: z.string(), content_type: z.string() } },
  async ({ file_path, filename, content_type, kind }: { file_path: string; filename: string; content_type: string; kind: string }) => {
    await mkdir(UPLOADS, { recursive: true });
    const key = `${kind}-${randomUUID().slice(0, 8)}`;
    await copyFile(file_path, join(UPLOADS, key));
    return ok({ key, content_type, filename: head(filename, 60) });
  }
);
reg(
  "internal_attach_media",
  { description: "Gateway-only: attach stored files to a ticket (idempotent).", inputSchema: { entity_id: z.string(), items: z.array(z.object({ key: z.string(), kind: z.string().optional(), label: z.string().optional(), cover: z.boolean().optional() })) } },
  async ({ entity_id, items }: { entity_id: string; items: { key: string; kind?: string; label?: string; cover?: boolean }[] }) => {
    const all = await loadTickets();
    const t = all.find((x) => x.entity_id === entity_id);
    if (!t) return fail(`no ticket ${entity_id}`);
    for (const it of items) if (!t.attachments.some((a) => a.key === it.key)) t.attachments.push({ key: it.key, kind: it.kind ?? "file", label: it.label, cover: it.cover });
    await saveTickets(all);
    return ok({ attached: t.attachments.map((a) => a.key) });
  }
);
reg(
  "internal_detach_media",
  { description: "Gateway-only: remove a file from a ticket.", inputSchema: { entity_id: z.string(), key: z.string() } },
  async ({ entity_id, key }: { entity_id: string; key: string }) => {
    const all = await loadTickets();
    const t = all.find((x) => x.entity_id === entity_id);
    if (!t) return fail(`no ticket ${entity_id}`);
    t.attachments = t.attachments.filter((a) => a.key !== key);
    await saveTickets(all);
    return ok({ detached: key });
  }
);

await server.connect(new StdioServerTransport());
log.info("support-intake MCP ready", { writes: process.env.AGENT_ALLOW_WRITES === "true", customers: CUSTOMERS.length });
