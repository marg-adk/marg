/**
 * context-trim.ts — keeps tool output from bloating the model's context.
 *
 * Every model call resends the ENTIRE conversation, and tool results (search results,
 * record dumps) can be huge. Left alone, one big result is paid for again on every
 * following call, forever. Two stages, both env-tunable:
 *
 *  1. At insertion: a tool result is capped at AGENT_TOOL_RESULT_MAX_CHARS (default 12000)
 *     with an explicit truncation marker so the model knows the output is partial and can
 *     re-query with tighter filters.
 *  2. At turn start: tool results older than the last AGENT_TRIM_TOOL_HISTORY_TURNS user
 *     turns (default 2) are squashed to AGENT_TOOL_RESULT_KEEP_CHARS (default 1500). The
 *     agent can always re-call the tool if it needs the detail again.
 *
 * Squashing mutates history exactly once per message (idempotent marker), just behind the
 * fresh-turn boundary — so the prompt-cache prefix bust lands near the end of the prefix.
 */
import { envNum } from "./env.js";
import type { ChatMessage } from "./llm.js";

export const trimConfig = {
  maxChars: envNum("AGENT_TOOL_RESULT_MAX_CHARS", 12_000),
  keepChars: envNum("AGENT_TOOL_RESULT_KEEP_CHARS", 1_500),
  freshTurns: envNum("AGENT_TRIM_TOOL_HISTORY_TURNS", 2),
};

const MARKER = /\n\[tool output trimmed: kept \d+ of \d+ chars\]$/;

function cut(text: string, keep: number): string {
  if (text.length <= keep || MARKER.test(text)) return text;
  return `${text.slice(0, keep)}\n[tool output trimmed: kept ${keep} of ${text.length} chars]`;
}

/** Cap a fresh tool result before it enters the conversation. */
export function trimToolResult(text: string): string {
  return cut(text, trimConfig.maxChars);
}

/** Squash tool results that predate the last `freshTurns` user turns, in place. Returns how many were newly squashed. */
export function trimHistoryToolResults(messages: ChatMessage[]): number {
  let boundary = messages.length;
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      seen++;
      if (seen >= trimConfig.freshTurns) {
        boundary = i;
        break;
      }
    }
  }
  if (seen < trimConfig.freshTurns) return 0;
  let trimmed = 0;
  for (let i = 0; i < boundary; i++) {
    const m = messages[i];
    if (m.role !== "tool" || !m.content || m.content.length <= trimConfig.keepChars || MARKER.test(m.content)) continue;
    m.content = cut(m.content, trimConfig.keepChars);
    trimmed++;
  }
  return trimmed;
}
