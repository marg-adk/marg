/**
 * mock/policy.ts — a scripted model for the __NAME__ journey (LLM_CHAIN=mock).
 *
 * The model's part of the journey as a state machine over the conversation, so the whole
 * platform runs with no key: CI, the playground, the evals. Keep it honest to the SHAPE of a
 * real model's job (resolve records, ask one thing, validate after every change, create only
 * after the runtime's summary). Replace with a real chain and nothing else changes.
 */
import { registerMockModel, type ChatMessage, type ToolCall } from "@marg/core";

let seq = 0;
const call = (name: string, args: Record<string, unknown>): ToolCall => ({ id: `mock_${++seq}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
const say = (content: string, ui?: unknown[]): ChatMessage => ({ role: "assistant", content: ui?.length ? `${content}\n${ui.map((b) => "```ui\n" + JSON.stringify(b) + "\n```").join("\n")}` : content });
const tools = (...calls: ToolCall[]): ChatMessage => ({ role: "assistant", content: null, tool_calls: calls });

registerMockModel(async (messages) => {
  const users = messages.filter((m) => m.role === "user" && typeof m.content === "string").map((m) => String(m.content));
  const lastUser = (users[users.length - 1] ?? "").trim();
  const firstUser = (users[0] ?? "").trim();
  const lastRole = messages[messages.length - 1]?.role;
  const sys = messages[0]?.role === "system" ? String(messages[0].content ?? "") : "";
  const summaryUp = /has drawn the confirmation summary card/.test(sys);

  // ---- after a tool result: say what happened --------------------------------------------
  if (lastRole === "tool") {
    const text = String(messages[messages.length - 1]?.content ?? "");
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (parsed?.created) return say(`Created ${parsed.label ?? parsed.entity_id}.`);
    if (/^ERROR/.test(text)) return say(`I couldn't do that: ${text.replace(/^ERROR:\s*/, "").slice(0, 160)}`);
    const problems: string[] = Array.isArray(parsed?.problems) ? parsed.problems : [];
    if (problems.some((p) => p.startsWith("title"))) return say("What is this about, in a few words?");
    return say("Noted.");
  }

  // ---- a user turn -------------------------------------------------------------------------
  // the summary is up: a yes creates (the runtime's gate decides whether the call goes through)
  if (summaryUp && /\b(yes|create|confirm|go ahead|ok|sure)\b/i.test(lastUser)) return tools(call("create___ENTITY__", { title: firstUser, confirmed: true }));
  // an injection probe or an off-scope ask: the one-line refusal
  if (/ignore (all )?(previous|prior) instructions|system prompt|reveal your|print your/i.test(lastUser)) return say("I can only help with __TITLE__ here — let's carry on.");
  // a question while a runtime ask is open: one line (the runtime draws its ask again)
  if (/\?\s*$/.test(lastUser)) return say("In short: pick what fits best; anything unknown can stay empty.");
  // the opener (and anything else): validate what we have — TODO: resolve records, ask one thing at a time
  return tools(call("validate___ENTITY___slots", { title: firstUser }));
});
