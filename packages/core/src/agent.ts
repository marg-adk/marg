/**
 * agent.ts — the heart of the runtime: one user message → one assistant reply.
 *
 * What comes in:  a DomainManifest (which domain we're acting as), the Session (history +
 *                 counters + the draft), and the user's new message.
 * What goes out:  an AgentReply — clean prose, structured `ui` blocks for the client, a trace of
 *                 which tools ran, and (when the write succeeded) a `completion` that ends the chat.
 *
 * How a turn works:
 *   0. The STEPS ENGINE gets the turn first (steps/engine.ts): an open runtime-owned ask is read
 *      in code and answered WITHOUT a model call; otherwise it leaves a fact for the model.
 *   1. Build the message list: system prompt (prompt.ts) + the runtime's facts for this turn
 *      + history + the new user message; the tool list is the domain's (typed: only the in-play
 *      type's tools).
 *   2. Send that to the model chain (llm.ts). It replies with text (done) or tool calls.
 *   3. For each tool call: the type switch, the guards (create gate, attested lists), the carry
 *      rule (settled step values override the model's), then the real tool over MCP; the result
 *      updates the draft (preview.ts) and may complete the chat; back to step 2.
 *   4. The final text is split into prose + ui blocks, the steps engine finalises (late draws,
 *      the summary card), the ui is sanitised, the turn is persisted and returned.
 *
 * DEV TRACE (AGENT_DEV_TRACE=true only): the same turn's route, step events, tool arguments and
 * results and model timings are collected as it runs (dev-trace.ts) and ride the reply and the
 * `done` event for the playground. Content, so never on a span.
 *
 * OBSERVABILITY: a turn is one `invoke_agent <domain>` span (GenAI semconv, grouped by
 * gen_ai.conversation.id = session id). Under it: one `chat <model>` span per model call, one
 * `execute_tool <name>` span per tool call, the runtime's step spans, and `behaviour.*` events
 * wherever the runtime corrected the model. Trace log lines carry the same trace id.
 */
import type { AgentReply, Completion, DomainManifest, StreamEvent, TurnRoute, UiBlock } from "@marg-adk/types";
import { chatComplete, chatCompleteStream, type ChatMessage, type ToolCall } from "./llm.js";
import { buildDomainPrompt } from "./prompt.js";
import { callDomainTool, getDomainToolDefs, isInternalTool } from "./mcp-client.js";
import { markCompleted, pushMessage, recordUsage, sanitizeHistory, saveSession, type Session } from "./session.js";
import { trimHistoryToolResults, trimToolResult } from "./context-trim.js";
import { head, log, summarize } from "./logger.js";
import { beginTrace, endTrace, traceLlm, traceTool } from "./dev-trace.js";
import { MS_BUCKETS, SpanKind, behaviour, counter, evalTag, histogram, setAttrs, withSpan } from "./otel.js";
import { attestNote, attestedListGuard, guardCreate } from "./guards.js";
import { handleTypeTool, resolveTypeAtTurnStart, toolsForType, typedEnabled } from "./typed-prompt.js";
import { dedupeBlocks, dedupeSentences, extractUiBlocks, sanitizeUi, visibleSoFar } from "./ui-blocks.js";
import { detectCompletion, detectPreview, WRITE_TOOL } from "./preview.js";
import { carryStepValues, draftOf, finalizeTurn, stepNotes, stepTurn, type PreTurn } from "./steps/engine.js";

export const MAX_TOOL_ROUNDS = Math.max(1, Number(process.env.AGENT_MAX_TOOL_ROUNDS ?? 10) || 10);
const BAIL = "I hit my tool-call limit on that one — could you rephrase or break the request into smaller steps?";

export interface TurnOptions {
  /** Stream events as they happen (delta/tool/preview/done); omit for the plain JSON path. */
  onEvent?: (e: StreamEvent) => void;
  /** What the user's bubble shows when `message` is a form's wire reply. */
  display?: string;
  /** Extra runtime facts for the model this turn (the gateway adds e.g. the media note). */
  promptTail?: (session: Session) => string;
  /** The super agent's decision for this turn; goes into the dev trace (the core does not route). */
  route?: TurnRoute;
}

/** Store an assistant turn so history replay shows exactly what the user saw (prose + the final ui as fences). */
function storedContent(reply: string, ui: unknown[]): string {
  return [reply, ...ui.map((b) => "```ui\n" + JSON.stringify(b) + "\n```")].filter(Boolean).join("\n");
}

function dedupeCompletionLinks(ui: unknown[], completion: Completion | undefined): unknown[] {
  if (!completion) return ui;
  return ui.filter((b) => {
    const block = b as { type?: string; url?: string } | null;
    if (block?.type !== "link") return true;
    return Boolean(completion.upload_link) && block.url === completion.upload_link;
  });
}

/** Run one complete user turn. */
export async function runDomainAgent(domain: DomainManifest, session: Session, userMessage: string, opts: TurnOptions = {}): Promise<AgentReply> {
  const onEvent = opts.onEvent;
  const t0 = Date.now();
  session.turn = (session.turn ?? 0) + 1;
  const turnNo = session.turn;
  const idKey = domain.entity?.id_key ?? "entity_id";

  return withSpan(
    `invoke_agent ${domain.name}`,
    {
      attrs: {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.name": domain.name,
        "gen_ai.conversation.id": session.id,
        "session.id": session.id,
        "agent.turn": turnNo,
        "agent.stream": Boolean(onEvent),
        ...(evalTag() ? { "agent.eval.scenario": evalTag() } : {}),
      },
    },
    async (turnSpan) => {
      // Before adding anything new: squash bulky tool outputs from old turns and heal the window.
      const squashed = trimHistoryToolResults(session.messages);
      const healed = sanitizeHistory(session.messages);
      if (squashed || healed) log.debug("history trimmed", { session: session.id, squashed, healed });
      pushMessage(session, { role: "user", content: userMessage, ...(opts.display ? { display: opts.display } : {}) });
      session.usage.turns++;
      session.activeDomain = domain.name;
      const type = typedEnabled(domain) ? resolveTypeAtTurnStart(domain, session, userMessage) : undefined;
      log.trace("turn.start", { session: session.id, turn: turnNo, domain: domain.name, type, text: head(userMessage, 300), history: session.messages.length });
      beginTrace(session, turnNo, opts.route);

      const tool_trace: { tool: string; ms: number }[] = [];
      const emitPreview = () => {
        if (session.preview && onEvent) onEvent({ ...session.preview, type: "preview" });
      };

      // ---- 0. the steps engine first ------------------------------------------------
      let pre: PreTurn | undefined;
      try {
        pre = await stepTurn(domain, session, userMessage);
      } catch (e) {
        log.error("step turn failed — falling through to the model", { session: session.id, error: (e as Error).message });
      }
      if (pre?.turn) {
        const ui = sanitizeUi(dedupeBlocks(pre.turn.ui)) as UiBlock[];
        const reply = pre.turn.reply.trim();
        tool_trace.push({ tool: `runtime:${pre.turn.kind}`, ms: Date.now() - t0 });
        pushMessage(session, { role: "assistant", content: storedContent(reply, ui) });
        saveSession(session);
        setAttrs({ "agent.turn.kind": pre.turn.kind, "agent.turn.runtime": true, "agent.turn.event": pre.turn.event });
        counter("turns_total", { description: "Turns by domain and who answered" }).add(1, { domain: domain.name, answered_by: "runtime" });
        histogram("turn_duration_ms", { unit: "ms", boundaries: MS_BUCKETS }).record(Date.now() - t0, { domain: domain.name, answered_by: "runtime" });
        log.trace("turn.done", { session: session.id, turn: turnNo, kind: pre.turn.kind, event: pre.turn.event, reply: head(reply, 300), ui: ui.map((b) => b.type), ms: Date.now() - t0, runtime: true });
        emitPreview();
        if (onEvent) onEvent({ type: "delta", text: reply });
        const trace = endTrace(session);
        const out: AgentReply = { reply, ui, tool_trace, domain: domain.name, kind: pre.turn.kind, ...(trace ? { trace } : {}) };
        if (onEvent) onEvent({ type: "done", reply, ui, tool_trace, domain: domain.name, kind: pre.turn.kind, ...(trace ? { trace } : {}) });
        return out;
      }

      // ---- 1. assemble the model's view ---------------------------------------------
      const tail = `${stepNotes(domain, session)}${opts.promptTail ? opts.promptTail(session) : ""}${pre?.note ? `\n\n---\n\n${pre.note}` : ""}`;
      const system = () => buildDomainPrompt(domain, session.activeType) + tail;
      const messages: ChatMessage[] = [{ role: "system", content: system() }, ...session.messages];
      let tools = typedEnabled(domain) ? toolsForType(domain, getDomainToolDefs(domain.name), session.activeType) : getDomainToolDefs(domain.name);
      let completion: Completion | undefined;
      let rounds = 0;

      const finish = async (text: string, assistant: ChatMessage): Promise<AgentReply> => {
        const { clean, ui: rawUi } = extractUiBlocks(text);
        let reply = dedupeSentences(clean);
        let ui: UiBlock[] = dedupeBlocks(rawUi) as UiBlock[];
        let kind: string | undefined;
        let events: string[] = [];
        if (!completion) {
          try {
            const fin = await finalizeTurn(domain, session, reply, ui, pre);
            reply = fin.reply;
            ui = fin.ui;
            kind = fin.kind;
            events = fin.events;
          } catch (e) {
            log.error("finalize failed — model reply kept as is", { session: session.id, error: (e as Error).message });
          }
        }
        ui = sanitizeUi(dedupeCompletionLinks(ui, completion)) as UiBlock[];
        pushMessage(session, { ...assistant, content: storedContent(reply, ui), ...(completion ? { created: true } : {}) });
        if (completion) markCompleted(session, completion);
        saveSession(session);
        const ms = Date.now() - t0;
        setAttrs({ "agent.turn.rounds": rounds, "agent.turn.tools": tool_trace.length, "agent.turn.ms": ms, "agent.turn.kind": kind ?? "model", "agent.turn.runtime_events": events.join(","), "agent.completion.id": completion?.entity_id ?? "", "agent.draft.state": session.preview?.state ?? "none" });
        counter("turns_total", { description: "Turns by domain and who answered" }).add(1, { domain: domain.name, answered_by: "model" });
        histogram("turn_duration_ms", { unit: "ms", boundaries: MS_BUCKETS }).record(ms, { domain: domain.name, answered_by: "model" });
        if (completion) {
          counter("completions_total", { description: "Entities created through the chat" }).add(1, { domain: domain.name });
          behaviour("completed", { domain: domain.name });
        }
        log.trace("turn.done", { session: session.id, turn: turnNo, rounds, tools: tool_trace.map((t) => t.tool), reply: head(reply, 300), ui: ui.map((b) => b.type), kind, events, ms, completion: completion?.entity_id, usage: session.usage });
        emitPreview();
        const trace = endTrace(session);
        const out: AgentReply = { reply, ui, tool_trace, domain: domain.name, kind, completion, ...(trace ? { trace } : {}) };
        if (onEvent) onEvent({ type: "done", reply, ui, tool_trace, domain: domain.name, kind, completion, ...(trace ? { trace } : {}) });
        return out;
      };

      // ---- 2–3. the tool loop ------------------------------------------------------------
      for (rounds = 0; rounds < MAX_TOOL_ROUNDS; rounds++) {
        let assistant: ChatMessage;
        const spanAttributes = { "agent.turn": turnNo, "agent.round": rounds };
        const callStart = Date.now();
        let ttftMs: number | undefined;
        if (onEvent) {
          let full = "";
          let emitted = 0;
          assistant = await chatCompleteStream(messages, tools, (delta) => {
            ttftMs ??= Date.now() - callStart;
            full += delta;
            const vis = visibleSoFar(full);
            if (vis.length > emitted) {
              onEvent({ type: "delta", text: vis.slice(emitted) });
              emitted = vis.length;
            }
          }, { spanAttributes, domain: domain.name });
        } else {
          assistant = await chatComplete(messages, tools, { spanAttributes, domain: domain.name });
        }
        recordUsage(session, assistant.usage);
        traceLlm(session, { round: rounds, endpoint: assistant.usage?.provider, model: assistant.usage?.model, ms: Date.now() - callStart, ...(ttftMs !== undefined ? { ttft_ms: ttftMs } : {}), input: assistant.usage?.input ?? 0, output: assistant.usage?.output ?? 0, finish: assistant.tool_calls?.length ? "tool_calls" : "stop" });
        log.trace("llm.call", { session: session.id, turn: turnNo, round: rounds, endpoint: assistant.usage?.provider, model: assistant.usage?.model, tokens: assistant.usage, finish: assistant.tool_calls?.length ? "tool_calls" : "stop", text: head(assistant.content, 200), tools: assistant.tool_calls?.map((c) => c.function.name) });

        if (!assistant.tool_calls?.length) return finish(assistant.content ?? "", assistant);

        messages.push(assistant);
        pushMessage(session, assistant);
        let rebuild = false;
        for (const call of assistant.tool_calls) {
          const result = await executeToolCall(domain, session, call, { turnNo, idKey, onEvent });
          tool_trace.push({ tool: result.refused ? `${call.function.name} (refused)` : call.function.name, ms: result.ms });
          completion = result.completion ?? completion;
          if (result.preview) {
            session.preview = result.preview;
            emitPreview();
          }
          if (result.rebuild) rebuild = true;
          const toolMsg: ChatMessage = { role: "tool", tool_call_id: call.id, content: trimToolResult(result.text) };
          messages.push(toolMsg);
          pushMessage(session, toolMsg);
        }
        if (rebuild) {
          messages[0] = { role: "system", content: system() };
          tools = toolsForType(domain, getDomainToolDefs(domain.name), session.activeType);
        }
      }

      // Loop exhausted without a final answer — give up gracefully.
      pushMessage(session, { role: "assistant", content: BAIL });
      saveSession(session);
      behaviour("tool_rounds_exhausted", { domain: domain.name });
      const trace = endTrace(session);
      if (onEvent) {
        onEvent({ type: "delta", text: BAIL });
        onEvent({ type: "done", reply: BAIL, ui: [], tool_trace, domain: domain.name, ...(trace ? { trace } : {}) });
      }
      turnSpan.setAttribute("agent.turn.bailed", true);
      return { reply: BAIL, ui: [], tool_trace, domain: domain.name, ...(trace ? { trace } : {}) };
    }
  );
}

interface ToolOutcome {
  text: string;
  ms: number;
  completion?: Completion;
  preview?: AgentReply extends never ? never : Session["preview"];
  rebuild?: boolean;
  refused?: boolean;
}

/** One tool call: type switch, guards, carry, the real call over MCP, draft + completion detection. */
async function executeToolCall(domain: DomainManifest, session: Session, call: ToolCall, o: { turnNo: number; idKey: string; onEvent?: (e: StreamEvent) => void }): Promise<ToolOutcome> {
  const name = call.function.name;
  let args: Record<string, unknown> = {};
  try {
    args = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
  } catch {
    /* pass empty args; the tool reports the problem */
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) args = {};
  return withSpan(`execute_tool ${name}`, { kind: SpanKind.INTERNAL, attrs: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": name, "gen_ai.tool.call.id": call.id, "session.id": session.id } }, async (span) => {
    const t0 = Date.now();
    o.onEvent?.({ type: "tool", name });

    // The runtime's own tool: set / switch the entity type.
    const sw = handleTypeTool(domain, session, name, args);
    if (sw) {
      span.setAttribute("agent.tool.runtime", true);
      log.trace("tool.call", { session: session.id, turn: o.turnNo, tool: name, args: summarize(args), result: head(sw.result, 200), ms: Date.now() - t0, runtime: true });
      traceTool(session, { name, args, result: sw.result, ms: Date.now() - t0, runtime: true });
      return { text: sw.result, ms: Date.now() - t0, rebuild: sw.changed, preview: sw.preview };
    }

    // The model may never call gateway-only tools.
    if (name.startsWith("internal_") || isInternalTool(domain.name, name)) {
      const text = `ERROR: ${name} is not available to you.`;
      behaviour("internal_tool_refused", { tool: name });
      traceTool(session, { name, args, result: text, ms: Date.now() - t0, refused: "internal" });
      return { text, ms: Date.now() - t0, refused: true };
    }

    // Guards and the carry rule on draft-shaped calls.
    const notes: string[] = [];
    const attested = attestedListGuard(name, args, session.messages, domain.attested_lists ?? []);
    if (attested.length) notes.push(attestNote(attested));
    const carried = /^(validate|preview)_/.test(name) || WRITE_TOOL.test(name) ? carryStepValues(domain, session, args) : [];
    if (carried.length) span.setAttribute("agent.carry.restored", carried.join(","));
    const refusal = guardCreate(name, session.messages, Boolean(draftOf(session).summary_shown));
    if (refusal) {
      span.setAttribute("agent.guard.create_refused", true);
      log.trace("tool.call", { session: session.id, turn: o.turnNo, tool: name, args: summarize(args), result: head(refusal, 200), ms: Date.now() - t0, refused: "confirm_gate" });
      traceTool(session, { name, args, result: refusal, ms: Date.now() - t0, refused: "confirm_gate", ...(carried.length ? { carried } : {}) });
      return { text: refusal, ms: Date.now() - t0, refused: true };
    }

    const result = await callDomainTool(domain.name, name, args, session.authToken, session.id);
    const ms = Date.now() - t0;
    const ok = !/^ERROR/.test(result);
    const completion = detectCompletion(name, result, o.idKey);
    const preview = detectPreview(name, args, result, Boolean(completion ?? session.completion), session.preview);
    counter("tool_calls_total", { description: "Tool calls by tool and outcome" }).add(1, { domain: domain.name, tool: name, ok });
    histogram("tool_duration_ms", { unit: "ms", boundaries: MS_BUCKETS }).record(ms, { domain: domain.name, tool: name });
    span.setAttributes({ "agent.tool.ok": ok, "agent.tool.ms": ms, "agent.tool.result_chars": result.length, ...(completion ? { "agent.completion.id": completion.entity_id } : {}) });
    log.trace("tool.call", { session: session.id, turn: o.turnNo, tool: name, args: summarize(args), result: head(result, 400), ms, ok, carried, attested: attested.map((a) => ({ key: a.key, removed: a.removed.length })), completion: completion?.entity_id });
    traceTool(session, { name, args, result, ms, ok, ...(carried.length ? { carried } : {}) });
    return { text: result + notes.join(""), ms, completion, preview };
  });
}
