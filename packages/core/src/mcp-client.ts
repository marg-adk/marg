/**
 * mcp-client.ts — how the runtime reaches its tools.
 *
 * MCP (Model Context Protocol) is an open standard for exposing tools to an agent: a server
 * (your domain's mcp/server.ts) advertises tools with JSON schemas, and a client (this file)
 * calls them over stdio — the runtime spawns the server as a CHILD PROCESS; no network port.
 *
 * Per-domain connections, keyed by domain name, so a chat only ever pays for the tools of the
 * domain it's actually in. Tools named `internal_*` are for the GATEWAY, not the model: they
 * stay callable through callDomainTool but are kept out of the tool list the model sees (an
 * upload tool with file bytes and record ids the model never authors).
 *
 * The user's bearer token rides in request `_meta` (protocol metadata the model never sees or
 * controls), the session id too (so the child's own trace lines join the chat's story), and the
 * W3C trace context (so the child's spans land in the gateway's trace).
 *
 * A crashed child must not wedge the domain forever: on a transport failure the call respawns
 * the server once and retries (production blocker #5 in the first vertical's review).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { REPO_ROOT } from "./env.js";
import { log } from "./logger.js";
import { SpanKind, SpanStatusCode, injectContext, withSpan } from "./otel.js";
import type { ToolDef } from "./llm.js";

interface DomainMcp {
  client: Client;
  toolDefs: ToolDef[];
  internal: string[];
  spec: { command: string; args: string[] };
  reconnects: number;
}

const connections = new Map<string, DomainMcp>();
const connecting = new Map<string, Promise<DomainMcp>>();

/** `_meta` key the MCP server reads the per-session user token from. Must match the server's AUTH_META_KEY. */
export const AUTH_META_KEY = "agent/auth";
/** `_meta` key carrying the chat's session id for the child's trace lines. */
export const SESSION_META_KEY = "agent/session";

async function spawn(domain: string, command: string, args: string[]): Promise<DomainMcp> {
  const transport = new StdioClientTransport({
    command,
    args,
    cwd: REPO_ROOT,
    // The child's stdout is the protocol channel: its logger must write to stderr only.
    env: { ...(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>), AGENT_LOG_TO_STDERR: "true" },
  });
  const client = new Client({ name: `marg-runtime-${domain}`, version: "0.1.0" });
  await client.connect(transport);
  const { tools } = await client.listTools();
  const toolDefs: ToolDef[] = tools
    .filter((t) => !t.name.startsWith("internal_"))
    .map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} } },
    }));
  const internal = tools.filter((t) => t.name.startsWith("internal_")).map((t) => t.name);
  const prev = connections.get(domain);
  const conn: DomainMcp = { client, toolDefs, internal, spec: { command, args }, reconnects: prev ? prev.reconnects + 1 : 0 };
  connections.set(domain, conn);
  log.info("MCP connected", { domain, tools: toolDefs.length, names: toolDefs.map((t) => t.function.name), gateway_only: internal, reconnects: conn.reconnects });
  return conn;
}

/** Spawn a domain's MCP server and connect to it (or return the cached connection). */
export async function connectDomainMcp(domain: string, command: string, args: string[]): Promise<DomainMcp> {
  const existing = connections.get(domain);
  if (existing) return existing;
  let p = connecting.get(domain);
  if (!p) {
    p = spawn(domain, command, args).finally(() => connecting.delete(domain));
    connecting.set(domain, p);
  }
  return p;
}

async function reconnect(domain: string): Promise<DomainMcp | undefined> {
  const old = connections.get(domain);
  if (!old) return undefined;
  try {
    await old.client.close().catch(() => {});
    connections.delete(domain);
    log.warn("MCP child unresponsive — respawning", { domain });
    return await connectDomainMcp(domain, old.spec.command, old.spec.args);
  } catch (e) {
    log.error("MCP respawn failed", { domain, error: (e as Error).message });
    return undefined;
  }
}

export function getDomainToolDefs(domain: string): ToolDef[] {
  return connections.get(domain)?.toolDefs ?? [];
}
export function isInternalTool(domain: string, name: string): boolean {
  return connections.get(domain)?.internal.includes(name) ?? false;
}
export function mcpState(): Record<string, { tools: number; internal: number; reconnects: number }> {
  return Object.fromEntries([...connections.entries()].map(([d, c]) => [d, { tools: c.toolDefs.length, internal: c.internal.length, reconnects: c.reconnects }]));
}

const TRANSPORT_FAILURE = /not connected|connection closed|EPIPE|ECONNRESET|write after end|transport closed|Request timed out|closed/i;

/**
 * Execute one tool on a domain's MCP server and return its output as text — or an
 * "ERROR calling …" string on failure. Errors are returned as text (not thrown) on purpose:
 * the string goes back to the model, which can read it and recover conversationally.
 */
export async function callDomainTool(domain: string, name: string, args: Record<string, unknown>, authToken?: string, sessionId?: string): Promise<string> {
  const conn = connections.get(domain);
  if (!conn) throw new Error(`MCP not connected for domain "${domain}"`);
  return withSpan(`mcp.call ${name}`, { kind: SpanKind.CLIENT, attrs: { "rpc.system": "mcp", "rpc.service": `${domain}`, "rpc.method": name, ...(sessionId ? { "session.id": sessionId } : {}) } }, async (span) => {
    const once = async (c: DomainMcp) => {
      const meta: Record<string, unknown> = { ...(authToken ? { [AUTH_META_KEY]: authToken } : {}), ...(sessionId ? { [SESSION_META_KEY]: sessionId } : {}) };
      injectContext(meta);
      const res = await c.client.callTool({ name, arguments: args, _meta: meta });
      const parts = (res.content as { type: string; text?: string }[] | undefined) ?? [];
      const text = parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
      const out = text || JSON.stringify(res);
      span.setAttribute("agent.tool.result_chars", out.length);
      if (res.isError || /^ERROR/.test(out)) span.setStatus({ code: SpanStatusCode.ERROR, message: out.slice(0, 200) });
      return out;
    };
    try {
      return await once(conn);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (TRANSPORT_FAILURE.test(msg)) {
        const fresh = await reconnect(domain);
        if (fresh) {
          try {
            span.addEvent("mcp.reconnected");
            return await once(fresh);
          } catch (e2) {
            const m2 = `ERROR calling ${name}: ${e2 instanceof Error ? e2.message : String(e2)}`;
            span.setStatus({ code: SpanStatusCode.ERROR, message: m2.slice(0, 200) });
            return m2;
          }
        }
      }
      const out = `ERROR calling ${name}: ${msg}`;
      span.recordException(e instanceof Error ? e : new Error(msg));
      span.setStatus({ code: SpanStatusCode.ERROR, message: out.slice(0, 200) });
      return out;
    }
  });
}

/** Shutdown: close every child so the process can exit cleanly. */
export async function closeAllMcp(): Promise<void> {
  for (const [domain, c] of connections) {
    await c.client.close().catch(() => {});
    connections.delete(domain);
  }
}
