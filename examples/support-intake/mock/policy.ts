/**
 * mock/policy.ts — a scripted "model" for the support-intake journey (LLM_CHAIN=mock).
 *
 * It plays the model's part of the journey deterministically — resolve the customer, ask the
 * category, validate after every slot, create after the runtime's confirmation — so the whole
 * platform (gateway, steps, guards, widget, evals, CI) runs with no key and no network. It is a
 * state machine over the conversation, not an understanding of language: it shows the SHAPE of
 * the model's job, and it lets the runtime-owned parts be tested exactly.
 *
 * Replace it with a real chain (LLM_CHAIN=openai,anthropic …) and nothing else changes.
 */
import { registerMockModel, type ChatMessage, type ToolCall } from "@marg-adk/core";

const CATEGORIES = ["billing", "technical", "account", "feature request"];

interface View {
  lastUser: string;
  firstUser: string;
  draft: Record<string, unknown>;
  customers: { customer_id: string; name: string; plan: string; city: string }[];
  lastToolName?: string;
  lastToolResult?: any;
  validated: boolean;
  summaryUp: boolean;
  created: boolean;
}

function view(messages: ChatMessage[]): View {
  const v: View = { lastUser: "", firstUser: "", draft: {}, customers: [], validated: false, summaryUp: false, created: false };
  const calls = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "user" && typeof m.content === "string") {
      v.lastUser = m.content;
      if (!v.firstUser) v.firstUser = m.content;
    }
    if (m.role === "assistant") for (const c of m.tool_calls ?? []) calls.set(c.id, c.function.name);
    if (m.role === "assistant" && m.tool_calls) {
      for (const c of m.tool_calls) {
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
      if (name === "search_customers" && parsed?.customers) v.customers = parsed.customers;
      if (name === "validate_ticket_slots" && parsed) v.validated = parsed.ok === true;
      if (name === "create_ticket" && parsed?.created) v.created = true;
      v.lastToolName = name;
      v.lastToolResult = parsed ?? m.content;
    }
  }
  const sys = messages[0]?.role === "system" ? String(messages[0].content) : "";
  v.summaryUp = /has drawn the confirmation summary card/.test(sys);
  return v;
}

let seq = 0;
const call = (name: string, args: Record<string, unknown>): ToolCall => ({ id: `mock_${++seq}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
const say = (content: string, ui?: unknown[]): ChatMessage => ({ role: "assistant", content: ui?.length ? `${content}\n${ui.map((b) => "```ui\n" + JSON.stringify(b) + "\n```").join("\n")}` : content });
const tools = (...calls: ToolCall[]): ChatMessage => ({ role: "assistant", content: null, tool_calls: calls });

/** "ticket for Northwind: login fails" → { customer: "Northwind", title: "login fails" } */
function parseOpener(text: string): { customer?: string; title?: string } {
  const m = /\bfor\s+([A-Za-z][\w&' .-]*?)\s*[:,—-]\s*(.+)$/i.exec(text) ?? /\bfor\s+([A-Za-z][\w&' .-]*?)[,:]\s*(.+)$/i.exec(text);
  if (m) return { customer: m[1].trim(), title: m[2].trim() };
  const m2 = /^(.*?)\s+for\s+([A-Za-z][\w&' .-]+)$/i.exec(text);
  if (m2) return { title: m2[1].replace(/^(?:create|open|log|raise)\s+(?:a\s+)?(?:ticket|issue|bug)\s*(?:for)?\s*/i, "").trim(), customer: m2[2].trim() };
  return {};
}

const SUMMARY_DONE = (d: Record<string, unknown>) => `Noted. Ticket for ${d.customer_name ?? "the customer"}: "${d.title}" (${d.category}).`;

registerMockModel(async (messages, _tools) => {
  const v = view(messages);
  const last = v.lastUser.trim();
  const lower = last.toLowerCase();
  const lastRole = messages[messages.length - 1]?.role;

  // ---- after a tool result: continue the plan ----------------------------------------------
  if (lastRole === "tool") {
    if (v.lastToolName === "search_customers") {
      const hits = v.customers;
      if (hits.length === 1) {
        const c = hits[0];
        const opener = parseOpener(v.firstUser);
        return tools(call("validate_ticket_slots", { ...v.draft, title: v.draft.title ?? opener.title ?? v.firstUser, customer_id: c.customer_id, customer_name: c.name }));
      }
      if (hits.length > 1) {
        return say("I found a few customers with that name — which one?", [{ type: "list", items: hits.map((c) => ({ title: c.name, subtitle: `${c.plan} · ${c.city}`, value: c.name })) }]);
      }
      return say("I couldn't find a customer by that name. What's the exact customer name?");
    }
    if (v.lastToolName === "validate_ticket_slots") {
      const r = v.lastToolResult;
      const problems: string[] = Array.isArray(r?.problems) ? r.problems : [];
      const rec = r?.from_record ?? {};
      const d = { ...v.draft, ...rec };
      if (problems.some((p) => p.startsWith("category"))) {
        return say(`Got it — ${d.customer_name ?? "the customer"}${rec.plan ? ` (${rec.plan}, ${rec.city})` : ""}: "${d.title}". Which category?`, [{ type: "chips", options: CATEGORIES.map((c) => ({ label: c.charAt(0).toUpperCase() + c.slice(1), value: c })) }]);
      }
      if (problems.some((p) => p.startsWith("customer_id"))) return say("Which customer is this for?");
      if (problems.some((p) => p.startsWith("title"))) return say("What's the issue, in a few words?");
      return say(SUMMARY_DONE(d));
    }
    if (v.lastToolName === "create_ticket") {
      const r = v.lastToolResult;
      if (r?.created) return say(`Ticket ${r.entity_id} created — status ${r.status ?? "open"}.`);
      return say(`I couldn't create the ticket: ${String(typeof r === "string" ? r : JSON.stringify(r)).replace(/^ERROR:\s*/, "").slice(0, 160)}`);
    }
    if (v.lastToolName === "whoami") return say("Hi! Tell me the issue and the customer, e.g. “ticket for Northwind: login fails on mobile”.");
    return say("Okay.");
  }

  // ---- a user turn -----------------------------------------------------------------------
  // the summary is up: a yes creates (the runtime's gate decides whether the call goes through)
  if (v.summaryUp && /\b(yes|create|confirm|go ahead|ok|sure)\b/i.test(lower)) {
    return tools(call("create_ticket", { ...v.draft, confirmed: true }));
  }
  // an injection probe or an off-scope ask: the one-line refusal
  if (/ignore (all )?(previous|prior) instructions|system prompt|reveal your|print your/i.test(lower)) {
    return say("I can only help with support tickets here — let's carry on with the ticket.");
  }
  // a customer pick from the list
  const pick = v.customers.find((c) => c.name.toLowerCase() === lower);
  if (pick) return tools(call("validate_ticket_slots", { ...v.draft, title: v.draft.title ?? parseOpener(v.firstUser).title ?? v.firstUser, customer_id: pick.customer_id, customer_name: pick.name }));
  // a category answer
  const cat = CATEGORIES.find((c) => lower === c || lower === c.charAt(0).toUpperCase() + c.slice(1) || new RegExp(`\\b${c}\\b`).test(lower));
  if (cat && v.draft.customer_id) return tools(call("validate_ticket_slots", { ...v.draft, category: cat }));
  // a question while a runtime ask is open: answer in one line (the runtime redraws its ask)
  if (/\?\s*$/.test(last) || /\bwhat (is|does|do)\b|\bwhy\b|\bhow\b/.test(lower)) {
    if (/environment/.test(lower)) return say("Environment is where the problem shows: production is your live service, staging the pre-release copy, local a developer's machine.");
    if (/priority|urgent/.test(lower)) return say("Priority sets the response time: urgent means someone is blocked right now.");
    return say("Good question — in short: fill what you know; anything unknown can stay empty.");
  }
  // the opener (or a restated title/customer)
  if (!v.draft.customer_id) {
    const o = parseOpener(last);
    if (o.customer) return tools(call("search_customers", { query: o.customer }));
    if (!v.draft.title && last.length > 3) return tools(call("validate_ticket_slots", { title: last }));
    return say("Which customer is this for?");
  }
  // a correction of the title
  if (/^(?:title|issue)\s*[:=]\s*(.+)$/i.test(last)) return tools(call("validate_ticket_slots", { ...v.draft, title: last.replace(/^(?:title|issue)\s*[:=]\s*/i, "") }));
  if (/^no\b|\bchange\b|\binstead\b/.test(lower)) return say("Tell me what to change — the title, the customer or the category.");
  return say("Noted.");
});
