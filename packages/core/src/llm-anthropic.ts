/**
 * llm-anthropic.ts — the Anthropic (Claude) adapter.
 *
 * Translates the runtime's internal OpenAI-style message shape to the Messages API and back.
 * The raw Anthropic content blocks are preserved on assistant messages (anthropic_content) so
 * thinking blocks replay unchanged on subsequent turns, as the API requires. Also owns, for the
 * Claude path: retry-with-backoff on transient failures, and prompt caching (cache_control
 * markers that make repeated prefixes ~10x cheaper — every turn resends the whole history).
 *
 * Called only from llm.ts (never directly by the agent).
 */
import Anthropic from "@anthropic-ai/sdk";
import { LlmUnavailableError, type CallOpts, type ChatMessage, type LlmEndpoint, type ToolDef } from "./llm.js";
import { log } from "./logger.js";

const clients = new Map<string, Anthropic>();
function getClient(ep: LlmEndpoint): Anthropic {
  let c = clients.get(ep.apiKey);
  if (!c) clients.set(ep.apiKey, (c = new Anthropic({ apiKey: ep.apiKey })));
  return c;
}

const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 529]);
function isTransient(e: unknown): boolean {
  if (e instanceof Anthropic.APIConnectionError || e instanceof Anthropic.APIConnectionTimeoutError || e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError) return true;
  const status = (e as { status?: number })?.status;
  if (typeof status === "number") return TRANSIENT_STATUS.has(status);
  const name = `${(e as { name?: string })?.name ?? ""} ${(e as { constructor?: { name?: string } })?.constructor?.name ?? ""}`;
  const msg = (e as { message?: string })?.message ?? "";
  return /APIConnection|Connection|Timeout|Abort|FetchError/i.test(name) || /connection error|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network|timeout|fetch failed|socket hang up|overloaded/i.test(msg);
}

async function withLlmRetry<T>(fn: () => Promise<T>, canRetry?: () => boolean): Promise<T> {
  const backoff = [400, 1200];
  let lastErr: unknown;
  for (let attempt = 0; attempt <= backoff.length; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt < backoff.length && isTransient(e) && (canRetry ? canRetry() : true)) {
        log.warn("llm transient error — retrying", { attempt: attempt + 1, status: (e as { status?: number })?.status, error: (e as Error)?.message?.slice(0, 160) });
        await new Promise((r) => setTimeout(r, backoff[attempt]));
        continue;
      }
      break;
    }
  }
  if (isTransient(lastErr)) {
    log.error("llm unavailable after retries", { error: (lastErr as Error)?.message?.slice(0, 200) });
    throw new LlmUnavailableError();
  }
  throw lastErr;
}

function toAnthropicTools(tools: ToolDef[]): Anthropic.Beta.BetaToolUnion[] {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: (t.function.parameters ?? { type: "object", properties: {} }) as Anthropic.Beta.BetaTool.InputSchema,
  }));
}

function toAnthropicMessages(messages: ChatMessage[]): Anthropic.Beta.BetaMessageParam[] {
  const out: Anthropic.Beta.BetaMessageParam[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      out.push({ role: "user", content: m.content ?? "" });
    } else if (m.role === "assistant") {
      if (m.anthropic_content) {
        out.push({ role: "assistant", content: m.anthropic_content as Anthropic.Beta.BetaContentBlockParam[] });
      } else {
        const blocks: Anthropic.Beta.BetaContentBlockParam[] = [];
        if (m.content) blocks.push({ type: "text", text: m.content });
        for (const tc of m.tool_calls ?? []) {
          let input: unknown = {};
          try {
            input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
          } catch {
            /* leave empty */
          }
          blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
        }
        if (blocks.length) out.push({ role: "assistant", content: blocks });
      }
    } else if (m.role === "tool") {
      const block: Anthropic.Beta.BetaToolResultBlockParam = { type: "tool_result", tool_use_id: m.tool_call_id ?? "", content: m.content ?? "" };
      const last = out[out.length - 1];
      if (last?.role === "user" && Array.isArray(last.content) && last.content.every((b: any) => b.type === "tool_result")) {
        (last.content as Anthropic.Beta.BetaToolResultBlockParam[]).push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
    }
  }
  return out;
}

/** Moving cache breakpoint: mark the last cacheable block of the final message so the whole prefix is written to the prompt cache. */
function addHistoryBreakpoint(msgs: Anthropic.Beta.BetaMessageParam[]): void {
  const last = msgs[msgs.length - 1];
  if (!last) return;
  if (typeof last.content === "string") {
    if (!last.content) return;
    last.content = [{ type: "text", text: last.content }];
  }
  const blocks = last.content as any[];
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (["text", "tool_result", "tool_use"].includes(blocks[i]?.type)) {
      blocks[i] = { ...blocks[i], cache_control: { type: "ephemeral" } };
      return;
    }
  }
}

function requestParams(ep: LlmEndpoint, messages: ChatMessage[], tools: ToolDef[], opts?: CallOpts) {
  const system = messages.find((m) => m.role === "system")?.content ?? undefined;
  const anthMessages = toAnthropicMessages(messages);
  addHistoryBreakpoint(anthMessages);
  return {
    model: opts?.model ?? ep.model,
    max_tokens: opts?.maxTokens ?? 16000,
    system: system ? [{ type: "text" as const, text: system, cache_control: { type: "ephemeral" as const } }] : undefined,
    messages: anthMessages,
    tools: tools.length ? toAnthropicTools(tools) : undefined,
    ...(ep.temperature !== undefined ? { temperature: ep.temperature } : {}),
    ...(ep.body ?? {}),
  };
}

function toChatMessage(response: Anthropic.Beta.BetaMessage): ChatMessage {
  const usage = {
    input: response.usage?.input_tokens ?? 0,
    output: response.usage?.output_tokens ?? 0,
    cache_read: response.usage?.cache_read_input_tokens ?? 0,
    cache_write: response.usage?.cache_creation_input_tokens ?? 0,
  };
  if (response.stop_reason === "refusal") {
    return { role: "assistant", content: "I wasn't able to process that request. Let's get back to what we were doing — what would you like to do next?", usage };
  }
  const text = response.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("");
  const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
  return {
    role: "assistant",
    content: text || null,
    tool_calls: toolUses.length ? toolUses.map((b) => ({ id: b.id, type: "function" as const, function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } })) : undefined,
    anthropic_content: response.content,
    usage,
  };
}

export async function chatCompleteStreamAnthropic(ep: LlmEndpoint, messages: ChatMessage[], tools: ToolDef[], onDelta: (text: string) => void, opts?: CallOpts): Promise<ChatMessage> {
  let emitted = 0;
  return withLlmRetry(
    async () => {
      const stream = getClient(ep).beta.messages.stream(requestParams(ep, messages, tools, opts));
      stream.on("text", (delta) => {
        emitted++;
        onDelta(delta);
      });
      const final = await stream.finalMessage();
      return toChatMessage(final);
    },
    () => emitted === 0
  );
}

export async function chatCompleteAnthropic(ep: LlmEndpoint, messages: ChatMessage[], tools: ToolDef[], opts?: CallOpts): Promise<ChatMessage> {
  return withLlmRetry(async () => toChatMessage(await getClient(ep).beta.messages.create(requestParams(ep, messages, tools, opts))));
}
