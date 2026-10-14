/**
 * mcp/server.ts — the bookings domain's tools, over MCP (stdio). The backend is a JSON file.
 *
 * WHAT COMES IN: tool calls from the gateway, with the user's token and the trace context in
 *   `_meta` (never in arguments).
 * WHAT COMES OUT: reads (whoami, search_venues, availability, get_my_bookings), and the triad —
 *   validate_booking_slots (write-free), preview_booking, create_booking (refuses without
 *   `confirmed:true` and AGENT_ALLOW_WRITES === "true").
 * WHO TALKS TO IT: the gateway's MCP client; the runtime's steps through ctx.call.
 *
 * Availability is computed, not stored, so the suite is deterministic: a venue's closed weekday
 * returns no slots and the nearest open days as alternatives; on an open day the hour slots are
 * always free and some half-hour slots are "taken" by a stable hash of venue + day + time.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { AUTH_META_KEY, SESSION_META_KEY, extractContext, head, initOtel, log, runInContext, SpanKind, SpanStatusCode, summarize, withSpan } from "@marg-adk/core";

initOtel({ service: "marg-bookings-mcp" });

const DIR = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(DIR, "..", ".data");
const BOOKINGS = join(DATA_DIR, "bookings.json");
interface Venue { venue_id: string; name: string; cuisine: string; area: string; max_party: number; closed_on: number[] }
const VENUES = JSON.parse(await readFile(join(DIR, "..", "fixtures", "venues.json"), "utf8")) as Venue[];

const OCCASIONS = ["birthday", "business", "date night", "none"];
const SLOTS = ["18:00", "18:30", "19:00", "19:30", "20:00", "20:30"];

interface Booking {
  entity_id: string;
  venue_id: string;
  venue_name: string;
  date: string;
  slot_time: string;
  party_size: number;
  occasion?: string;
  notes?: string;
  created_at: string;
  created_by?: string;
}

// ---- per-call auth context ------------------------------------------------------------
const auth = new AsyncLocalStorage<{ token?: string; session?: string }>();
const who = () => (auth.getStore()?.token ? "user-" + Buffer.from(auth.getStore()!.token!).toString("base64url").slice(0, 6) : "demo-user");

const slotSchema = {
  venue_id: z.string().optional().describe("from search_venues — never invented"),
  venue_name: z.string().optional(),
  date: z.string().optional().describe("YYYY-MM-DD, from the Details card"),
  party_size: z.union([z.number(), z.string()]).optional(),
  occasion: z.string().optional(),
  slot_time: z.string().optional().describe("HH:MM, from the availability chips"),
  notes: z.string().optional(),
};
type Slots = { [K in keyof typeof slotSchema]?: unknown };

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: `ERROR: ${msg}` }], isError: true });

const isoDay = (s: unknown): boolean => /^\d{4}-\d{2}-\d{2}$/.test(String(s ?? "")) && !Number.isNaN(Date.parse(String(s) + "T00:00:00Z"));
const weekday = (day: string): number => new Date(day + "T00:00:00Z").getUTCDay();
const addDays = (day: string, n: number): string => new Date(Date.parse(day + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Fri 6 Nov" — the label the chips and the summary use. */
export const dayLabel = (day: string): string => {
  const d = new Date(day + "T00:00:00Z");
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};
const hash = (s: string): number => {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h;
};
/** Open times on a day: none on the venue's closed weekday; hour slots always free; half-hours by a stable hash. */
function openSlots(v: Venue, day: string): string[] {
  if (v.closed_on.includes(weekday(day))) return [];
  return SLOTS.filter((t) => t.endsWith(":00") || hash(`${v.venue_id}|${day}|${t}`) % 3 !== 0);
}
/** The nearest open days after `day` with their first free time — what the Time step offers when the day is full or closed. */
function alternatives(v: Venue, day: string, n = 3): { date: string; time: string; label: string }[] {
  const out: { date: string; time: string; label: string }[] = [];
  for (let i = 1; i <= 14 && out.length < n; i++) {
    const d = addDays(day, i);
    const slots = openSlots(v, d);
    if (slots.length) out.push({ date: d, time: slots[0], label: `${dayLabel(d)} · ${slots[0]}` });
  }
  return out;
}

async function loadBookings(): Promise<Booking[]> {
  try {
    return JSON.parse(await readFile(BOOKINGS, "utf8")) as Booking[];
  } catch {
    return [];
  }
}
async function saveBookings(b: Booking[]): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(BOOKINGS, JSON.stringify(b, null, 2));
}

/** Validate the draft: fill from the venue record, apply defaults, list what is missing. Write-free. */
function validate(s: Slots): { ok: boolean; problems: string[]; from_record: Record<string, string>; defaults: Record<string, string> } {
  const problems: string[] = [];
  const from_record: Record<string, string> = {};
  const defaults: Record<string, string> = {};
  const venue = VENUES.find((v) => v.venue_id === s.venue_id);
  if (!venue) problems.push("venue_id (resolve the venue with search_venues)");
  else {
    from_record.venue_name = venue.name;
    from_record.cuisine = venue.cuisine;
    from_record.area = venue.area;
    if (s.party_size !== undefined && String(s.party_size).trim() !== "") {
      const n = Number(String(s.party_size).trim());
      if (!Number.isInteger(n) || n < 1) problems.push("party_size must be a whole number of guests");
      else if (n > venue.max_party) problems.push(`party_size: ${venue.name} seats up to ${venue.max_party}`);
    }
  }
  if (s.date !== undefined && String(s.date) !== "" && !isoDay(s.date)) problems.push("date must be YYYY-MM-DD");
  if (s.occasion !== undefined && String(s.occasion) !== "" && !OCCASIONS.includes(String(s.occasion))) problems.push(`occasion must be one of ${OCCASIONS.join(", ")}`);
  if (!s.occasion) defaults.occasion = "none";
  return { ok: problems.length === 0, problems, from_record, defaults };
}

const server = new McpServer({ name: "bookings", version: "0.1.0" });
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
      withSpan(`mcp.tool ${name}`, { kind: SpanKind.SERVER, attrs: { "rpc.system": "mcp", "rpc.service": "bookings", "rpc.method": name, "gen_ai.tool.name": name, ...(session ? { "session.id": session } : {}) } }, async (span) => {
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
      }),
    );
  }) as any);
}

// ---- reads ------------------------------------------------------------------------------
reg("whoami", { description: "The current user's identity. Call once at session start." }, async () => ok({ user_id: who(), name: "Demo guest" }));
reg("search_venues", { description: "Venues whose name contains the query (case-insensitive). Returns {venues:[{venue_id,name,cuisine,area,max_party}]}; offer two or more as a list.", inputSchema: { query: z.string() } }, async ({ query }: { query: string }) => {
  const q = query.trim().toLowerCase();
  const venues = VENUES.filter((v) => v.name.toLowerCase().includes(q)).map(({ closed_on: _closed, ...v }) => v);
  return ok({ venues });
});
reg("reference_data", { description: "Option lists: occasions.", inputSchema: { kind: z.enum(["occasions"]) } }, async () => ok({ options: OCCASIONS }));
reg("availability", { description: "Open times at a venue on a day (YYYY-MM-DD): {slots:[HH:MM], alternatives:[{date,time,label}]} — alternatives are the nearest open days when the day has nothing.", inputSchema: { venue_id: z.string(), date: z.string() } }, async ({ venue_id, date }: { venue_id: string; date: string }) => {
  const v = VENUES.find((x) => x.venue_id === venue_id);
  if (!v) return fail("unknown venue");
  if (!isoDay(date)) return fail("date must be YYYY-MM-DD");
  const slots = openSlots(v, date);
  return ok({ venue: v.name, date, day: dayLabel(date), slots, alternatives: slots.length ? [] : alternatives(v, date), closed: v.closed_on.includes(weekday(date)) });
});
reg("get_my_bookings", { description: "The user's bookings, newest first." }, async () => ok({ bookings: (await loadBookings()).filter((b) => b.created_by === who()).slice(-20).reverse() }));

// ---- the triad ----------------------------------------------------------------------------
reg("validate_booking_slots", { description: "Validate the draft booking (write-free): fills from the venue record, applies defaults, lists what is missing. Call after every slot change.", inputSchema: slotSchema }, async (s: Slots) => ok(validate(s)));
reg("preview_booking", { description: "What create_booking would write, for the live draft.", inputSchema: slotSchema }, async (s: Slots) => {
  const v = validate(s);
  return ok({ ...v, preview: { ...s, ...v.from_record, ...v.defaults } });
});
reg("create_booking", { description: "Create the booking. Refuses without confirmed:true (the user confirmed the runtime's summary) and with writes disabled.", inputSchema: { ...slotSchema, confirmed: z.boolean().optional() } }, async (s: Slots & { confirmed?: boolean }) => {
  if (s.confirmed !== true) return fail("not confirmed — the summary must be shown and the user must say yes");
  if (process.env.AGENT_ALLOW_WRITES !== "true") return fail("writes are disabled (AGENT_ALLOW_WRITES)");
  const v = validate(s);
  if (!v.ok) return fail(`invalid: ${v.problems.join("; ")}`);
  if (!isoDay(s.date)) return fail("invalid: date");
  if (!/^\d{2}:\d{2}$/.test(String(s.slot_time ?? ""))) return fail("invalid: slot_time");
  const venue = VENUES.find((x) => x.venue_id === s.venue_id)!;
  const booking: Booking = {
    entity_id: "BKG-" + randomUUID().slice(0, 6).toUpperCase(),
    venue_id: venue.venue_id,
    venue_name: venue.name,
    date: String(s.date),
    slot_time: String(s.slot_time),
    party_size: Number(s.party_size ?? 2),
    occasion: s.occasion ? String(s.occasion) : "none",
    notes: s.notes ? String(s.notes) : undefined,
    created_at: new Date().toISOString(),
    created_by: who(),
  };
  const all = await loadBookings();
  all.push(booking);
  await saveBookings(all);
  return ok({ created: true, entity_id: booking.entity_id, label: `Booking ${booking.entity_id} — ${venue.name}, ${dayLabel(booking.date)}, ${booking.slot_time}, ${booking.party_size} ${booking.party_size === 1 ? "person" : "people"}` });
});
reg("internal_delete_booking", { description: "Remove a booking (the e2e proof-record cleanup).", inputSchema: { entity_id: z.string() } }, async ({ entity_id }: { entity_id: string }) => {
  const all = await loadBookings();
  await saveBookings(all.filter((b) => b.entity_id !== entity_id));
  return ok({ deleted: true });
});

await server.connect(new StdioServerTransport());
