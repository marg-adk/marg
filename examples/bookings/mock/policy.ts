/**
 * mock/policy.ts — a scripted "model" for the booking journey (LLM_CHAIN=mock).
 *
 * It plays the model's part deterministically — resolve the venue, validate after every slot,
 * answer a question in one line, create after the runtime's confirmation — so the domain runs
 * with no key in the playground, the suite and CI. Registered under the domain's name: two
 * example domains share one gateway, each with its own policy.
 */
import { registerMockModel, type ChatMessage, type ToolCall } from "@marg-adk/core";

interface Venue { venue_id: string; name: string; cuisine: string; area: string; max_party: number }
interface View {
  lastUser: string;
  firstUser: string;
  draft: Record<string, unknown>;
  venues: Venue[];
  lastToolName?: string;
  lastToolResult?: any;
  summaryUp: boolean;
}

function view(messages: ChatMessage[]): View {
  const v: View = { lastUser: "", firstUser: "", draft: {}, venues: [], summaryUp: false };
  const calls = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "user" && typeof m.content === "string") {
      v.lastUser = m.content;
      if (!v.firstUser) v.firstUser = m.content;
    }
    if (m.role === "assistant") {
      for (const c of m.tool_calls ?? []) {
        calls.set(c.id, c.function.name);
        if (/^validate_/.test(c.function.name)) {
          try {
            Object.assign(v.draft, JSON.parse(c.function.arguments));
          } catch {
            /* ignore */
          }
        }
      }
    }
    if (m.role === "tool") {
      const name = calls.get(m.tool_call_id ?? "");
      let parsed: any;
      try {
        parsed = JSON.parse(m.content ?? "");
      } catch {
        parsed = undefined;
      }
      if (name === "search_venues" && parsed?.venues) v.venues = parsed.venues;
      v.lastToolName = name;
      v.lastToolResult = parsed ?? m.content;
    }
  }
  const sys = messages[0]?.role === "system" ? String(messages[0].content) : "";
  v.summaryUp = /has drawn the confirmation summary card/.test(sys);
  return v;
}

let seq = 0;
const call = (name: string, args: Record<string, unknown>): ToolCall => ({ id: `mockb_${++seq}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
const say = (content: string, ui?: unknown[]): ChatMessage => ({ role: "assistant", content: ui?.length ? `${content}\n${ui.map((b) => "```ui\n" + JSON.stringify(b) + "\n```").join("\n")}` : content });
const tools = (...calls: ToolCall[]): ChatMessage => ({ role: "assistant", content: null, tool_calls: calls });

/** "book a table at Harbour House for 4" → { venue: "Harbour House", party: 4 } */
function parseOpener(text: string): { venue?: string; party?: number } {
  const party = /\bfor\s+(\d{1,2})\b/i.exec(text) ?? /\btable\s+for\s+(\d{1,2})\b/i.exec(text);
  const at = /\b(?:at|@)\s+([A-Z][\w&' ]*?)(?=\s+(?:for|on|tomorrow|tonight|this|next)\b|\s*[,.!]|$)/i.exec(text);
  if (at) return { venue: at[1].trim(), party: party ? Number(party[1]) : undefined };
  const verb = /\b(?:book|reserve)\s+(?:a\s+table\s+at\s+)?([A-Z][\w&' ]*?)(?=\s+(?:for|on|tomorrow|tonight|this|next)\b|\s*[,.!]|$)/i.exec(text);
  if (verb && !/^(a|the|me|us|table)$/i.test(verb[1].trim())) return { venue: verb[1].trim(), party: party ? Number(party[1]) : undefined };
  return { party: party ? Number(party[1]) : undefined };
}
/** "sorry, I meant Harbour Lights" / "actually Harbour Lights" / "change the venue to Mezze House" */
function parseCorrection(text: string): string | undefined {
  const m = /\b(?:meant|actually|instead|make it|change (?:the )?venue to|rather)\s+([A-Z][\w&' ]*?)\s*[,.!]?$/i.exec(text.trim());
  return m ? m[1].trim() : undefined;
}

registerMockModel(async (messages, _tools) => {
  const v = view(messages);
  const last = v.lastUser.trim();
  const lower = last.toLowerCase();
  const lastRole = messages[messages.length - 1]?.role;
  const venueOf = (id: unknown) => v.venues.find((x) => x.venue_id === id);

  // ---- after a tool result: continue the plan ----------------------------------------------
  if (lastRole === "tool") {
    if (v.lastToolName === "search_venues") {
      const hits = v.venues;
      const opener = parseOpener(v.firstUser);
      if (hits.length === 1) {
        const x = hits[0];
        return tools(call("validate_booking_slots", { ...v.draft, venue_id: x.venue_id, venue_name: x.name, ...(opener.party && !v.draft.party_size ? { party_size: opener.party } : {}) }));
      }
      if (hits.length > 1) return say("I found a few venues with that name — which one?", [{ type: "list", items: hits.map((x) => ({ title: x.name, subtitle: `${x.cuisine} · ${x.area}`, value: x.name })) }]);
      return say("I couldn't find a venue by that name. What's the exact name?");
    }
    if (v.lastToolName === "validate_booking_slots") {
      const r = v.lastToolResult;
      const problems: string[] = Array.isArray(r?.problems) ? r.problems : [];
      const rec = r?.from_record ?? {};
      if (problems.some((p) => p.startsWith("venue_id"))) return say("Where would you like to book?");
      const seats = problems.find((p) => p.startsWith("party_size"));
      if (seats) return say(`${rec.venue_name ?? "That venue"} can't take that many — ${seats.replace(/^party_size:\s*/, "")}. How many should I put down?`);
      const venue = venueOf(v.draft.venue_id);
      return say(`Great — ${rec.venue_name ?? "the venue"}${rec.cuisine ? ` (${rec.cuisine} · ${rec.area}${venue ? `, up to ${venue.max_party}` : ""})` : ""}. When, and for how many?`);
    }
    if (v.lastToolName === "create_booking") {
      const r = v.lastToolResult;
      if (r?.created) return say(`${r.label ?? `Booking ${r.entity_id} confirmed`}.`);
      return say(`I couldn't make the booking: ${String(typeof r === "string" ? r : JSON.stringify(r)).replace(/^ERROR:\s*/, "").slice(0, 160)}`);
    }
    if (v.lastToolName === "whoami") return say("Hi! Tell me where and for how many, e.g. “book a table at Harbour House for 4”.");
    return say("Okay.");
  }

  // ---- a user turn -----------------------------------------------------------------------
  if (v.summaryUp && /\b(yes|book|confirm|go ahead|ok|sure)\b/i.test(lower)) return tools(call("create_booking", { ...v.draft, confirmed: true }));
  if (/ignore (all )?(previous|prior) instructions|system prompt|reveal your|print your/i.test(lower)) return say("I can only help with table bookings here — let's carry on with the booking.");
  // a venue pick from the list
  const pick = v.venues.find((x) => x.name.toLowerCase() === lower);
  if (pick) {
    const opener = parseOpener(v.firstUser);
    return tools(call("validate_booking_slots", { ...v.draft, venue_id: pick.venue_id, venue_name: pick.name, ...(opener.party && !v.draft.party_size ? { party_size: opener.party } : {}) }));
  }
  // a correction of the venue mid-flow
  const corrected = parseCorrection(last);
  if (corrected && v.draft.venue_id) return tools(call("search_venues", { query: corrected }));
  // a question while a runtime ask is open: one line (the runtime redraws its ask)
  if (/\?\s*$/.test(last) || /\b(do you|can i|is there|what (is|does|do)|how)\b/.test(lower)) {
    if (/walk-?in/.test(lower)) return say("Walk-ins are welcome when there's room, but a booking is the only way to be sure of a table.");
    if (/occasion/.test(lower)) return say("Occasion just helps the venue prepare — a candle on a birthday, a quieter table for business. Pick “Nothing special” otherwise.");
    if (/large|big group|how many/.test(lower)) return say("Each venue has a maximum party; I'll tell you if yours is over it once the details are in.");
    if (/dress|smart|casual/.test(lower)) return say("Smart casual is fine everywhere on the list.");
    return say("Good question — in short: fill in what you know; I'll check the rest.");
  }
  // the opener
  if (!v.draft.venue_id) {
    const o = parseOpener(last);
    if (o.venue) return tools(call("search_venues", { query: o.venue }));
    return say("Where would you like to book? Give me the venue's name.");
  }
  if (/^no\b|\bchange\b|\binstead\b/.test(lower)) return say("Tell me what to change — the venue, or use the card for the day, the party and the time.");
  return say("Noted.");
}, "bookings");
