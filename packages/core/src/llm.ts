/**
 * llm.ts — the runtime's single doorway to the model.
 *
 * Everything else (the agent loop, the router, the decision engine's LLM backend) calls
 * chatComplete / chatCompleteStream here and never talks to a model SDK directly. This file
 * defines the provider-neutral message shapes (the OpenAI wire format, the de-facto standard)
 * and drives a PROVIDER CHAIN with failover:
 *
 *   LLM_CHAIN=openai,anthropic        LLM_CHAIN=ollama        LLM_CHAIN=mock
 *
 * Each model call tries the endpoints in that order. Any failure (network, 429, 5xx, malformed
 * reply, per-adapter retries exhausted) moves on to the next endpoint; only when every endpoint
 * fails does the caller see an LlmUnavailableError. A circuit breaker per endpoint skips one that
 * failed LLM_FAILOVER_THRESHOLD times in a row for LLM_FAILOVER_COOLDOWN_S seconds, so a dead
 * primary doesn't add a timeout to every turn.
 *
 * Endpoint kinds:
 *  - "anthropic": Claude via the official SDK — see llm-anthropic.ts
 *  - "openai-compatible": any chat-completions endpoint — OpenAI, Ollama, vLLM, llama.cpp,
 *    LM Studio, Fireworks, Together, DeepSeek, Groq, Mistral, OpenRouter, Gemini's OpenAI surface…
 *  - "mock": a scripted model registered in-process (registerMockModel) — the offline path the
 *    example domain, the evals and CI run on with no key at all.
 *
 * MODEL CONFIGURATION IS PER ENDPOINT, NEVER GLOBAL: temperature, reasoning effort, token-cap
 * field, extra body fields, price and notes all live on `LLM_<NAME>_*` (a lesson: GPT-5 rejects a
 * fixed temperature, Gemini needs a thought signature echoed, Claude has its own knobs).
 *
 * What comes in:  a message history + tool definitions.
 * What goes out:  one assistant ChatMessage — either final text or tool calls — plus token usage
 *                 (tagged with provider, model and USD cost) for metering.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { REPO_ROOT } from "./env.js";
import { BRAND } from "./config.js";
import { head, log, redact } from "./logger.js";
import { MS_BUCKETS, SpanKind, counter, failSpan, histogram, otelConfig, otelContext, providerName, registerGauge, spanEvent, startSpan, withSpan, type Attributes } from "./otel.js";

export type LlmProvider = "anthropic" | "openai-compatible" | "mock";

/** A failure whose message is safe to show the user verbatim: every endpoint in the chain is down. */
export class LlmUnavailableError extends Error {
  userSafe = true;
  status = 503;
  constructor(message = `${BRAND}'s assistant is briefly unavailable — your details are saved. Please try again in a moment.`) {
    super(message);
    this.name = "LlmUnavailableError";
  }
}

// ---------------------------------------------------------------------------
// Message shapes (OpenAI wire format)
// ---------------------------------------------------------------------------

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  /** Provider payload echoed back verbatim with the call (Gemini's thought signature). */
  extra_content?: unknown;
}

export interface TokenUsage {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  provider?: string;
  model?: string;
  cost_usd?: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /** Raw Anthropic content blocks (assistant turns) — replayed verbatim so thinking blocks survive. */
  anthropic_content?: unknown;
  usage?: TokenUsage;
  /** User turns: what the chat bubble shows when `content` is a form's wire reply. Never sent to a model. */
  display?: string;
  /** The assistant message that closed the turn which CREATED the entity. Never sent to a model. */
  created?: boolean;
  /** Raw logprobs from an OpenAI-compatible endpoint when the call asked for them (decision backends). */
  logprobs?: unknown;
}

export interface ToolDef {
  type: "function";
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}

export interface CallOpts {
  /** Model id override; applies only to endpoints of the primary's kind. */
  model?: string;
  maxTokens?: number;
  /** false ⇒ don't append the serving model's notes (utility hops like routing). */
  modelNotes?: boolean;
  spanAttributes?: Record<string, string | number | boolean>;
  /** Extra request-body fields for this call only (e.g. {logprobs:true, top_logprobs:20}). OpenAI-compatible endpoints only. */
  body?: Record<string, unknown>;
  temperature?: number;
}

// ---------------------------------------------------------------------------
// Endpoint configuration
// ---------------------------------------------------------------------------

export interface Price {
  input: number;
  cached: number;
  output: number;
  cache_write: number;
}
export type AuthStyle = "bearer" | "header";

export interface LlmEndpoint {
  name: string;
  kind: LlmProvider;
  base: string;
  model: string;
  apiKey: string;
  auth: AuthStyle;
  /** Header name when auth is "header" (e.g. "api-subscription-key"). */
  authHeader?: string;
  price?: Price;
  temperature?: number;
  maxTokensKey: "max_tokens" | "max_completion_tokens";
  body?: Record<string, unknown>;
  notes?: string;
  notesFile?: string;
}

/** Known endpoints: base URL and auth style prefilled so .env only needs LLM_<NAME>_MODEL and LLM_<NAME>_API_KEY. */
const PRESETS: Record<string, Partial<LlmEndpoint>> = {
  anthropic: { kind: "anthropic" },
  mock: { kind: "mock" },
  openai: { base: "https://api.openai.com/v1", temperature: undefined, maxTokensKey: "max_completion_tokens", body: { reasoning_effort: "none" } },
  ollama: { base: "http://localhost:11434/v1", model: "llama3.3" },
  vllm: { base: "http://localhost:8000/v1" },
  llamacpp: { base: "http://localhost:8080/v1", model: "default" },
  lmstudio: { base: "http://localhost:1234/v1", model: "default" },
  fireworks: { base: "https://api.fireworks.ai/inference/v1" },
  together: { base: "https://api.together.xyz/v1" },
  deepseek: { base: "https://api.deepseek.com/v1" },
  gemini: { base: "https://generativelanguage.googleapis.com/v1beta/openai" },
  groq: { base: "https://api.groq.com/openai/v1" },
  mistral: { base: "https://api.mistral.ai/v1" },
  openrouter: { base: "https://openrouter.ai/api/v1" },
};

/** Built-in price table (USD per 1M tokens). Override per endpoint with LLM_<NAME>_PRICE="input,cached,output[,cache_write]". Unknown models cost 0 and say so once. */
const PRICE_TABLE: [RegExp, Price][] = [
  [/claude-opus-5|claude-opus-4/, { input: 5, cached: 0.5, output: 25, cache_write: 6.25 }],
  [/claude-sonnet-5/, { input: 2, cached: 0.2, output: 10, cache_write: 2.5 }],
  [/claude-sonnet-4/, { input: 3, cached: 0.3, output: 15, cache_write: 3.75 }],
  [/claude-haiku-4-5|claude-haiku-5/, { input: 1, cached: 0.1, output: 5, cache_write: 1.25 }],
  [/gpt-5\.6-luna/, { input: 0.2, cached: 0.02, output: 1.2, cache_write: 0.2 }],
  [/gpt-5\.4-mini/, { input: 0.75, cached: 0.075, output: 4.5, cache_write: 0.75 }],
  [/gpt-5\.6-terra/, { input: 2, cached: 0.2, output: 12, cache_write: 2 }],
  [/gemini-3\.[678]-flash$/, { input: 0.75, cached: 0.075, output: 3.75, cache_write: 0.75 }],
  [/deepseek-v4p1-flash|deepseek-flash/, { input: 0.22, cached: 0.007, output: 0.66, cache_write: 0.22 }],
];

function priceFor(model: string, override: string | undefined, kind: LlmProvider): Price | undefined {
  if (override) {
    const [input, cached, output, cache_write] = override.split(",").map((s) => Number(s.trim()));
    if ([input, cached, output].every((n) => Number.isFinite(n))) return { input, cached, output, cache_write: Number.isFinite(cache_write) ? cache_write : input };
    log.warn("LLM price override ignored — expected 'input,cached,output[,cache_write]'", { override });
  }
  if (kind === "mock") return { input: 0, cached: 0, output: 0, cache_write: 0 };
  return PRICE_TABLE.find(([re]) => re.test(model))?.[1];
}

export const llmConfig = {
  base: (process.env.LLM_API_BASE ?? "").replace(/\/+$/, ""),
  model: process.env.LLM_MODEL ?? "",
  apiKey: process.env.LLM_API_KEY ?? "",
};

const failoverConfig = {
  threshold: Math.max(1, Number(process.env.LLM_FAILOVER_THRESHOLD ?? 2) || 2),
  cooldownMs: Math.max(0, Number(process.env.LLM_FAILOVER_COOLDOWN_S ?? 60) || 60) * 1000,
  timeoutMs: Math.max(1000, Number(process.env.LLM_TIMEOUT_MS ?? 120000) || 120000),
  retries: Math.max(0, Number(process.env.LLM_RETRIES ?? 2) || 0),
  retryMaxWaitMs: Math.max(1000, Number(process.env.LLM_RETRY_MAX_WAIT_MS ?? 20000) || 20000),
};

const isLocal = (base: string): boolean => /localhost|127\.0\.0\.1|\[::1\]|\.local(?::|\/|$)/.test(base);

function endpointFromEnv(rawName: string): LlmEndpoint | undefined {
  const name = rawName.trim().toLowerCase();
  if (!name) return undefined;
  const key = name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const env = (suffix: string) => process.env[`LLM_${key}_${suffix}`];
  const presetName = (env("PRESET") ?? name).toLowerCase();
  const preset = PRESETS[presetName] ?? {};
  const presetKey = presetName.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  if (preset.kind === "mock") {
    return { name, kind: "mock", base: "", model: env("MODEL") ?? "mock", apiKey: "", auth: "bearer", price: priceFor("mock", undefined, "mock"), maxTokensKey: "max_tokens" };
  }
  if (preset.kind === "anthropic") {
    const model = env("MODEL") ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";
    const apiKey = env("API_KEY") ?? process.env.ANTHROPIC_API_KEY ?? "";
    if (!apiKey) {
      log.warn("LLM_CHAIN names anthropic but ANTHROPIC_API_KEY is unset — skipping it", { name });
      return undefined;
    }
    return { name, kind: "anthropic", base: "", model, apiKey, auth: "bearer", price: priceFor(model, env("PRICE"), "anthropic"), maxTokensKey: "max_tokens" };
  }
  const base = (env("BASE") ?? preset.base ?? "").replace(/\/+$/, "");
  const model = env("MODEL") ?? preset.model ?? "";
  const apiKey = env("API_KEY") ?? (presetName !== name ? process.env[`LLM_${presetKey}_API_KEY`] : undefined) ?? "";
  const authHeader = env("AUTH_HEADER") ?? preset.authHeader;
  const tempEnv = env("TEMPERATURE");
  const temperature = tempEnv === undefined ? ("temperature" in preset ? preset.temperature : 0.3) : tempEnv.toLowerCase() === "none" ? undefined : Number(tempEnv);
  let body: Record<string, unknown> | undefined = preset.body ? { ...preset.body } : undefined;
  if (env("BODY")) {
    try {
      const extra = JSON.parse(env("BODY")!) as Record<string, unknown>;
      body = { ...body };
      for (const [k, v] of Object.entries(extra)) {
        if (v === null) delete body[k];
        else body[k] = v;
      }
    } catch {
      log.warn("LLM_<NAME>_BODY is not valid JSON — ignored (prefer LLM_<NAME>_REASONING_EFFORT)", { name });
    }
  }
  const effort = env("REASONING_EFFORT");
  if (effort !== undefined) {
    body = { ...body };
    if (effort.toLowerCase() === "omit") delete body.reasoning_effort;
    else body.reasoning_effort = effort;
  }
  if (!base || !model || (!apiKey && !isLocal(base))) {
    log.warn("LLM_CHAIN endpoint incomplete — skipping it", { name, base_set: Boolean(base), model_set: Boolean(model), key_set: Boolean(apiKey) });
    return undefined;
  }
  return { name, kind: "openai-compatible", base, model, apiKey, auth: authHeader ? "header" : "bearer", authHeader, price: priceFor(model, env("PRICE"), "openai-compatible"), temperature, maxTokensKey: preset.maxTokensKey ?? "max_tokens", body };
}

/** Legacy single-provider config (no LLM_CHAIN): LLM_PROVIDER / ANTHROPIC_API_KEY pick Claude, else LLM_API_BASE + LLM_MODEL. */
function legacyChain(): LlmEndpoint[] {
  const explicit = process.env.LLM_PROVIDER;
  if (explicit === "mock") return [{ name: "mock", kind: "mock", base: "", model: "mock", apiKey: "", auth: "bearer", price: priceFor("mock", undefined, "mock"), maxTokensKey: "max_tokens" }];
  const useAnthropic = explicit === "anthropic" || (explicit !== "openai-compatible" && Boolean(process.env.ANTHROPIC_API_KEY));
  if (useAnthropic) {
    const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";
    return [{ name: "anthropic", kind: "anthropic", base: "", model, apiKey: process.env.ANTHROPIC_API_KEY ?? "", auth: "bearer", price: priceFor(model, undefined, "anthropic"), maxTokensKey: "max_tokens" }];
  }
  if (llmConfig.base && llmConfig.model) {
    return [{ name: "openai-compatible", kind: "openai-compatible", base: llmConfig.base, model: llmConfig.model, apiKey: llmConfig.apiKey, auth: "bearer", price: priceFor(llmConfig.model, process.env.LLM_PRICE, "openai-compatible"), temperature: 0.3, maxTokensKey: "max_tokens" }];
  }
  // Nothing configured: the scripted mock keeps the platform runnable (the example domain registers one).
  log.warn("no model configured (LLM_CHAIN / ANTHROPIC_API_KEY / LLM_API_BASE) — using the in-process mock model");
  return [{ name: "mock", kind: "mock", base: "", model: "mock", apiKey: "", auth: "bearer", price: priceFor("mock", undefined, "mock"), maxTokensKey: "max_tokens" }];
}

let chainCache: LlmEndpoint[] | undefined;
export function llmChain(): LlmEndpoint[] {
  if (!chainCache) {
    const names = (process.env.LLM_CHAIN ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (names.length) {
      chainCache = names.map(endpointFromEnv).filter((e): e is LlmEndpoint => Boolean(e));
      if (!chainCache.length) log.error("LLM_CHAIN is set but no endpoint is usable — every model call will fail", { chain: names });
    } else {
      chainCache = legacyChain();
    }
    for (const ep of chainCache) {
      attachNotes(ep);
      if (!ep.price && ep.kind !== "mock") log.warn("no price known for model — usage will meter tokens but cost 0; set LLM_<NAME>_PRICE", { endpoint: ep.name, model: ep.model });
    }
    const built = chainCache;
    registerGauge("llm_endpoint_open", () => built.map((ep) => ({ value: isOpen(ep) ? 1 : 0, attrs: { endpoint: ep.name, model: ep.model } })), { description: "1 while the endpoint's circuit breaker is open" });
  }
  return chainCache;
}
/** Test seam: rebuild the chain after changing the environment. */
export function resetLlmChain(): void {
  chainCache = undefined;
}

/** Per-model notes: shared-skills/model-notes/<model-id-slug>.md appended to the system prompt ONLY when that model serves the call. */
function attachNotes(ep: LlmEndpoint): void {
  const key = ep.name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const explicit = process.env[`LLM_${key}_NOTES`];
  if (explicit?.toLowerCase() === "none") return;
  const slug = ep.model.split("/").pop()!.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const rel = explicit ?? join("shared-skills", "model-notes", `${slug}.md`);
  const path = isAbsolute(rel) ? rel : join(REPO_ROOT, rel);
  if (!existsSync(path)) {
    if (explicit) log.warn("model notes file not found — continuing without notes", { endpoint: ep.name, file: rel });
    return;
  }
  const text = readFileSync(path, "utf8").trim();
  if (!text) return;
  ep.notes = text;
  ep.notesFile = rel;
  log.info("model notes attached", { endpoint: ep.name, model: ep.model, file: rel, chars: text.length });
}

function withNotes(messages: ChatMessage[], ep: LlmEndpoint, opts?: CallOpts): ChatMessage[] {
  if (!ep.notes || opts?.modelNotes === false || messages[0]?.role !== "system") return messages;
  return [{ ...messages[0], content: `${messages[0].content ?? ""}\n\n---\n\n${ep.notes}` }, ...messages.slice(1)];
}

export function activeProvider(): LlmProvider {
  return llmChain()[0]?.kind ?? "openai-compatible";
}

// ---------------------------------------------------------------------------
// Mock model (offline path)
// ---------------------------------------------------------------------------

export type MockModel = (messages: ChatMessage[], tools: ToolDef[], opts?: CallOpts) => ChatMessage | Promise<ChatMessage>;
let mockModel: MockModel | undefined;
/** Register the scripted model the "mock" endpoint serves (the example domain's policy, a test's canned replies). */
export function registerMockModel(fn: MockModel | undefined): void {
  mockModel = fn;
}
async function runMock(messages: ChatMessage[], tools: ToolDef[], opts?: CallOpts): Promise<ChatMessage> {
  const fn: MockModel = mockModel ?? (() => ({ role: "assistant", content: "I'm the mock model — register a policy with registerMockModel() or configure LLM_CHAIN." }) as ChatMessage);
  const out = await fn(messages, tools, opts);
  const usage = out.usage ?? { input: Math.ceil(messages.reduce((n, m) => n + (m.content?.length ?? 0), 0) / 4), output: Math.ceil((out.content?.length ?? 0) / 4), cache_read: 0, cache_write: 0 };
  return { ...out, usage };
}

// ---------------------------------------------------------------------------
// Circuit breaker + chain snapshot
// ---------------------------------------------------------------------------

interface Health {
  failures: number;
  openUntil: number;
  served: number;
  failed: number;
  lastError?: string;
  lastErrorAt?: number;
}
const health = new Map<string, Health>();
const healthOf = (name: string): Health => {
  let h = health.get(name);
  if (!h) health.set(name, (h = { failures: 0, openUntil: 0, served: 0, failed: 0 }));
  return h;
};
const isOpen = (ep: LlmEndpoint) => healthOf(ep.name).openUntil > Date.now();
function markOk(ep: LlmEndpoint) {
  const h = healthOf(ep.name);
  if (h.openUntil) log.info("llm endpoint recovered", { endpoint: ep.name });
  h.failures = 0;
  h.openUntil = 0;
  h.served++;
}
function markFail(ep: LlmEndpoint, err: unknown) {
  const h = healthOf(ep.name);
  h.failures++;
  h.failed++;
  h.lastError = (err instanceof Error ? err.message : String(err)).slice(0, 300);
  h.lastErrorAt = Date.now();
  if (h.failures >= failoverConfig.threshold && failoverConfig.cooldownMs > 0) {
    h.openUntil = Date.now() + failoverConfig.cooldownMs;
    counter("llm_circuit_opened_total", { description: "Times an endpoint's circuit breaker opened" }).add(1, { endpoint: ep.name, model: ep.model });
    log.warn("llm endpoint circuit opened — skipping it for the cooldown", { endpoint: ep.name, failures: h.failures, cooldown_s: failoverConfig.cooldownMs / 1000 });
  }
}

/** Ops view of the chain for /api/health and the startup log — never includes keys. */
export function llmChainSnapshot() {
  const chain = llmChain();
  const now = Date.now();
  return {
    primary: chain[0]?.name ?? null,
    model: chain[0]?.model ?? null,
    kind: chain[0]?.kind ?? null,
    failover: { threshold: failoverConfig.threshold, cooldown_s: failoverConfig.cooldownMs / 1000, timeout_ms: failoverConfig.timeoutMs, retries: failoverConfig.retries },
    chain: chain.map((ep) => {
      const h = healthOf(ep.name);
      return {
        name: ep.name,
        kind: ep.kind,
        model: ep.model,
        base: ep.base || undefined,
        key_set: ep.kind === "mock" || Boolean(ep.apiKey) || (ep.kind === "openai-compatible" && isLocal(ep.base)),
        priced: Boolean(ep.price),
        notes: ep.notesFile ?? null,
        state: h.openUntil > now ? "open" : "ok",
        served: h.served,
        failed: h.failed,
        consecutive_failures: h.failures,
        last_error: h.lastError,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Chain driver
// ---------------------------------------------------------------------------

function tagUsage(msg: ChatMessage, ep: LlmEndpoint, model: string): void {
  const u = msg.usage ?? { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  const p = ep.price;
  u.provider = ep.name;
  u.model = model;
  u.cost_usd = p ? (u.input * p.input + u.cache_read * p.cached + u.cache_write * p.cache_write + u.output * p.output) / 1e6 : 0;
  msg.usage = u;
}

function modelFor(ep: LlmEndpoint, opts: CallOpts | undefined): string {
  const primaryKind = llmChain()[0]?.kind;
  return opts?.model && ep.kind === primaryKind ? opts.model : ep.model;
}

let messagesForShape: ChatMessage[] = [];
function requestShape(messages: ChatMessage[]): Record<string, unknown> {
  const roles = messages.map((m) => (m.role === "assistant" && m.tool_calls?.length ? `assistant+${m.tool_calls.length}calls` : m.role));
  return { messages: messages.length, chars: messages.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0), head_roles: roles.slice(0, 4), tail_roles: roles.slice(-6) };
}

async function runChain(attempt: (ep: LlmEndpoint, model: string) => Promise<ChatMessage>, opts: CallOpts | undefined, emitted: () => boolean): Promise<ChatMessage> {
  const chain = llmChain();
  if (!chain.length) throw new LlmUnavailableError();
  let order = chain.filter((ep) => !isOpen(ep));
  if (!order.length) order = chain;
  let lastErr: unknown;
  for (let i = 0; i < order.length; i++) {
    const ep = order[i];
    const model = modelFor(ep, opts);
    const { span, ctx } = startSpan(`llm.attempt ${ep.name}`, { attrs: { "agent.llm.endpoint": ep.name, "agent.llm.attempt_index": i, "agent.llm.failover": i > 0, "gen_ai.provider.name": providerName(ep.name, ep.kind, ep.base), "gen_ai.request.model": model } });
    try {
      const msg = await otelContext.with(ctx, () => attempt(ep, model));
      markOk(ep);
      tagUsage(msg, ep, model);
      counter("llm_calls_total", { description: "Model calls per endpoint attempt and outcome" }).add(1, { endpoint: ep.name, model, outcome: "ok" });
      if (i > 0) {
        log.info("llm served by failover endpoint", { endpoint: ep.name, model, skipped: order.slice(0, i).map((e) => e.name) });
        counter("llm_failovers_total", { description: "Calls served by a later endpoint than the primary" }).add(1, { from: order[0].name, to: ep.name });
      }
      span.end();
      return msg;
    } catch (err) {
      lastErr = err;
      markFail(ep, err);
      counter("llm_calls_total").add(1, { endpoint: ep.name, model, outcome: "failed" });
      const status = (err as { status?: number })?.status;
      if (typeof status === "number") span.setAttribute("http.response.status_code", status);
      failSpan(span, err);
      span.end();
      const next = order[i + 1]?.name;
      log.warn("llm endpoint failed", { endpoint: ep.name, model, error: healthOf(ep.name).lastError, next: next ?? "none — giving up", request: requestShape(messagesForShape) });
      if (emitted()) throw err;
    }
  }
  log.error("every llm endpoint failed", { tried: order.map((e) => e.name), error: lastErr instanceof Error ? lastErr.message : String(lastErr) });
  counter("llm_unavailable_total", { description: "Model calls where every endpoint in the chain failed" }).add(1, { tried: order.map((e) => e.name).join(",") });
  throw new LlmUnavailableError();
}

// ---------------------------------------------------------------------------
// The `chat` span (GenAI semantic conventions)
// ---------------------------------------------------------------------------

function cut(s: unknown, headChars: number, fullChars: number): string {
  return otelConfig.captureContent === "full" ? redact(String(s ?? "")).slice(0, fullChars) : head(s, headChars);
}
function captureInput(messages: ChatMessage[]): Attributes {
  const mode = otelConfig.captureContent;
  if (mode === "off") return {};
  const system = messages.find((m) => m.role === "system")?.content;
  const tail = messages.filter((m) => m.role !== "system").slice(mode === "full" ? -40 : -4);
  const shaped = tail.map((m) => ({
    role: m.role,
    parts: [
      ...(m.content ? [{ type: m.role === "tool" ? "tool_call_response" : "text", ...(m.tool_call_id ? { id: m.tool_call_id } : {}), content: cut(m.content, 300, 4000) }] : []),
      ...(m.tool_calls ?? []).map((c) => ({ type: "tool_call", id: c.id, name: c.function.name, arguments: cut(c.function.arguments, 200, 2000) })),
    ],
  }));
  return {
    ...(system ? { "gen_ai.system_instructions": cut(system, 200, 3000), "agent.llm.system_chars": system.length } : {}),
    "gen_ai.input.messages": JSON.stringify(shaped).slice(0, mode === "full" ? 60000 : 6000),
  };
}
function captureOutput(msg: ChatMessage): Attributes {
  if (otelConfig.captureContent === "off") return {};
  const parts = [...(msg.content ? [{ type: "text", content: cut(msg.content, 300, 6000) }] : []), ...(msg.tool_calls ?? []).map((c) => ({ type: "tool_call", id: c.id, name: c.function.name, arguments: cut(c.function.arguments, 300, 2000) }))];
  return { "gen_ai.output.messages": JSON.stringify([{ role: "assistant", parts, finish_reason: msg.tool_calls?.length ? "tool_calls" : "stop" }]).slice(0, otelConfig.captureContent === "full" ? 30000 : 6000) };
}

async function chatSpan(messages: ChatMessage[], tools: ToolDef[], opts: CallOpts | undefined, stream: boolean, run: (onFirstDelta: () => void) => Promise<ChatMessage>): Promise<ChatMessage> {
  const primary = llmChain()[0];
  const model = primary ? modelFor(primary, opts) : "unknown";
  const primaryProvider = primary ? providerName(primary.name, primary.kind, primary.base) : "unknown";
  const t0 = Date.now();
  let ttftMs: number | undefined;
  return withSpan(
    `chat ${model}`,
    {
      kind: SpanKind.CLIENT,
      attrs: {
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": model,
        "gen_ai.request.stream": stream,
        "gen_ai.provider.name": primaryProvider,
        ...(primary ? { "agent.llm.endpoint": primary.name } : {}),
        ...(opts?.maxTokens ? { "gen_ai.request.max_tokens": opts.maxTokens } : {}),
        "agent.llm.messages": messages.length,
        "agent.llm.tools": tools.length,
        "agent.llm.prompt_chars": messages.reduce((n, m) => n + (m.content?.length ?? 0), 0),
        ...captureInput(messages),
        ...(opts?.spanAttributes ?? {}),
      },
    },
    async (span) => {
      const msg = await run(() => {
        if (ttftMs !== undefined) return;
        ttftMs = Date.now() - t0;
        span.setAttributes({ "gen_ai.response.time_to_first_chunk": ttftMs / 1000, "agent.llm.ttft_ms": ttftMs });
      });
      const ms = Date.now() - t0;
      const u = msg.usage;
      const served = u?.provider ?? primary?.name ?? "unknown";
      const servedModel = u?.model ?? model;
      const ep = llmChain().find((e) => e.name === served);
      const provider = ep ? providerName(ep.name, ep.kind, ep.base) : primaryProvider;
      if (servedModel !== model) span.updateName(`chat ${servedModel}`);
      const finish = msg.tool_calls?.length ? "tool_calls" : "stop";
      const opAttrs = { "gen_ai.operation.name": "chat", "gen_ai.provider.name": provider, "gen_ai.request.model": servedModel };
      if (u) {
        const promptTotal = u.input + u.cache_read + u.cache_write;
        span.setAttributes({
          "gen_ai.provider.name": provider,
          "gen_ai.response.model": servedModel,
          "agent.llm.endpoint": served,
          "gen_ai.usage.input_tokens": promptTotal,
          "gen_ai.usage.output_tokens": u.output,
          "gen_ai.usage.total_tokens": promptTotal + u.output,
          "gen_ai.usage.cache_read.input_tokens": u.cache_read,
          "gen_ai.usage.cache_creation.input_tokens": u.cache_write,
          "agent.llm.tokens.input_uncached": u.input,
          "gen_ai.usage.cost": +(u.cost_usd ?? 0).toFixed(6),
          "gen_ai.response.finish_reasons": [finish],
          "agent.llm.finish": finish,
          "agent.llm.ms": ms,
          "agent.llm.cache_hit_ratio": promptTotal ? +(u.cache_read / promptTotal).toFixed(3) : 0,
          ...captureOutput(msg),
        });
        const labels = { endpoint: served, model: servedModel };
        const tokens = counter("llm_tokens_total", { description: "Tokens by kind (input = uncached input, cache_read, cache_write, output)", unit: "{token}" });
        tokens.add(u.input, { ...labels, kind: "input" });
        tokens.add(u.output, { ...labels, kind: "output" });
        tokens.add(u.cache_read, { ...labels, kind: "cache_read" });
        tokens.add(u.cache_write, { ...labels, kind: "cache_write" });
        counter("llm_cost_usd_total", { description: "USD at each endpoint's price table", unit: "USD" }).add(u.cost_usd ?? 0, labels);
        const tokUsage = histogram("gen_ai_client_token_usage", { unit: "{token}", boundaries: [1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576] });
        tokUsage.record(promptTotal, { ...opAttrs, "gen_ai.token.type": "input" });
        tokUsage.record(u.output, { ...opAttrs, "gen_ai.token.type": "output" });
      }
      histogram("gen_ai_client_operation_duration", { unit: "s", boundaries: [0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92] }).record(ms / 1000, opAttrs);
      histogram("llm_duration_ms", { unit: "ms", boundaries: MS_BUCKETS }).record(ms, { endpoint: served, model: servedModel, finish });
      if (ttftMs !== undefined) histogram("llm_ttft_ms", { unit: "ms", boundaries: MS_BUCKETS }).record(ttftMs, { endpoint: served, model: servedModel });
      return msg;
    }
  );
}

/** One non-streaming model call. Throws LlmUnavailableError when every endpoint failed. */
export async function chatComplete(messages: ChatMessage[], tools: ToolDef[], opts?: CallOpts): Promise<ChatMessage> {
  messagesForShape = messages;
  return chatSpan(messages, tools, opts, false, () =>
    runChain(
      async (ep, model) => {
        if (ep.kind === "mock") return runMock(messages, tools, opts);
        if (ep.kind === "anthropic") {
          const { chatCompleteAnthropic } = await import("./llm-anthropic.js");
          return chatCompleteAnthropic(ep, withNotes(messages, ep, opts), tools, { ...opts, model });
        }
        return openaiCompatible(ep, model, withNotes(messages, ep, opts), tools, opts);
      },
      opts,
      () => false
    )
  );
}

/** Streaming completion: text deltas via onDelta, then the same ChatMessage as chatComplete. Failover happens only before the first delta. */
export async function chatCompleteStream(messages: ChatMessage[], tools: ToolDef[], onDelta: (text: string) => void, opts?: Pick<CallOpts, "spanAttributes" | "maxTokens">): Promise<ChatMessage> {
  messagesForShape = messages;
  let emitted = 0;
  return chatSpan(messages, tools, opts, true, (onFirstDelta) => {
    const forward = (t: string) => {
      if (!emitted) onFirstDelta();
      emitted++;
      onDelta(t);
    };
    return runChain(
      async (ep, model) => {
        if (ep.kind === "mock") {
          const msg = await runMock(messages, tools, opts);
          if (msg.content) forward(msg.content);
          return msg;
        }
        if (ep.kind === "anthropic") {
          const { chatCompleteStreamAnthropic } = await import("./llm-anthropic.js");
          return chatCompleteStreamAnthropic(ep, withNotes(messages, ep), tools, forward, opts);
        }
        return openaiCompatible(ep, model, withNotes(messages, ep), tools, opts, forward);
      },
      undefined,
      () => emitted > 0
    );
  });
}

// ---------------------------------------------------------------------------
// OpenAI-compatible transport
// ---------------------------------------------------------------------------

function toWireMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  return messages.map((m) => {
    const w: Record<string, unknown> = { role: m.role, content: m.content ?? "" };
    if (m.tool_calls?.length) w.tool_calls = m.tool_calls;
    if (m.tool_call_id) w.tool_call_id = m.tool_call_id;
    return w;
  });
}

function authHeaders(ep: LlmEndpoint): Record<string, string> {
  if (!ep.apiKey) return {};
  if (ep.auth === "header" && ep.authHeader) return { [ep.authHeader]: ep.apiKey };
  return { Authorization: `Bearer ${ep.apiKey}` };
}

function usageFromOpenAI(u: any): TokenUsage {
  const cached = Number(u?.prompt_tokens_details?.cached_tokens ?? u?.prompt_cache_hit_tokens ?? 0) || 0;
  const prompt = Number(u?.prompt_tokens ?? (Number(u?.prompt_cache_hit_tokens ?? 0) + Number(u?.prompt_cache_miss_tokens ?? 0))) || 0;
  const completion = Number(u?.completion_tokens ?? 0) || 0;
  const total = Number(u?.total_tokens ?? 0) || 0;
  return { input: Math.max(prompt - cached, 0), output: Math.max(completion, total - prompt, 0), cache_read: cached, cache_write: 0 };
}

class LlmHttpError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterMs?: number) {
    super(message);
    this.name = "LlmHttpError";
  }
}

function retryAfterFrom(res: Response, text: string): number | undefined {
  const h = Number(res.headers.get("retry-after"));
  if (Number.isFinite(h) && h > 0) return h * 1000;
  const m = /try again in (\d+(?:\.\d+)?)\s*(ms|s)\b/i.exec(text);
  if (m) return Number(m[1]) * (m[2].toLowerCase() === "ms" ? 1 : 1000);
  return undefined;
}

function isTransient(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  const status = /HTTP (\d{3})/.exec(m)?.[1];
  if (status) return status === "408" || status === "425" || status === "429" || status.startsWith("5");
  return true;
}

async function openaiCompatible(ep: LlmEndpoint, model: string, messages: ChatMessage[], tools: ToolDef[], opts: CallOpts | undefined, onDelta?: (text: string) => void): Promise<ChatMessage> {
  let emitted = false;
  const forward = onDelta
    ? (t: string) => {
        emitted = true;
        onDelta(t);
      }
    : undefined;
  for (let attempt = 0; ; attempt++) {
    try {
      return await openaiCompatibleOnce(ep, model, messages, tools, opts, forward);
    } catch (err) {
      const asked = err instanceof LlmHttpError ? err.retryAfterMs : undefined;
      const budget = asked !== undefined ? failoverConfig.retries * 2 : failoverConfig.retries;
      if (emitted || attempt >= budget || !isTransient(err)) throw err;
      const delay = Math.min(Math.max(1000 * 2 ** attempt, asked !== undefined ? asked + 500 : 0), failoverConfig.retryMaxWaitMs);
      log.warn("llm endpoint transient error — retrying", { endpoint: ep.name, attempt: attempt + 1, delay_ms: delay, asked_ms: asked, error: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
      const status = err instanceof LlmHttpError ? String(err.status) : "network";
      spanEvent("llm.retry", { endpoint: ep.name, attempt: attempt + 1, delay_ms: delay, status });
      counter("llm_retries_total", { description: "Same-endpoint retries on transient errors" }).add(1, { endpoint: ep.name, status });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

async function openaiCompatibleOnce(ep: LlmEndpoint, model: string, messages: ChatMessage[], tools: ToolDef[], opts: CallOpts | undefined, onDelta?: (text: string) => void): Promise<ChatMessage> {
  const stream = Boolean(onDelta);
  const temperature = opts?.temperature ?? ep.temperature;
  const res = await fetch(`${ep.base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: stream ? "text/event-stream" : "application/json", ...authHeaders(ep) },
    body: JSON.stringify({
      model,
      messages: toWireMessages(messages),
      tools: tools.length ? tools : undefined,
      tool_choice: tools.length ? "auto" : undefined,
      ...(temperature !== undefined ? { temperature } : {}),
      ...(opts?.maxTokens ? { [ep.maxTokensKey]: opts.maxTokens } : {}),
      ...(ep.body ?? {}),
      ...(opts?.body ?? {}),
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    }),
    signal: AbortSignal.timeout(failoverConfig.timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new LlmHttpError(`${ep.name} HTTP ${res.status}: ${text.slice(0, 500)}`, res.status, retryAfterFrom(res, text));
  }
  if (!stream) {
    const body: any = await res.json().catch(() => null);
    const choice = body?.choices?.[0];
    const msg = choice?.message;
    if (!msg) throw new Error(`${ep.name} returned no message: ${JSON.stringify(body)?.slice(0, 300)}`);
    const out = normalizeAssistant(msg, usageFromOpenAI(body?.usage));
    if (choice?.logprobs !== undefined && choice.logprobs !== null) out.logprobs = choice.logprobs;
    return out;
  }
  return readSse(res, ep, onDelta!);
}

function normalizeAssistant(msg: any, usage: TokenUsage): ChatMessage {
  const calls: ToolCall[] | undefined = Array.isArray(msg.tool_calls) && msg.tool_calls.length
    ? msg.tool_calls.map((c: any, i: number) => ({
        id: String(c.id ?? `call_${i}`),
        type: "function" as const,
        function: { name: String(c.function?.name ?? ""), arguments: typeof c.function?.arguments === "string" ? c.function.arguments : JSON.stringify(c.function?.arguments ?? {}) },
        ...(c.extra_content !== undefined ? { extra_content: c.extra_content } : {}),
      }))
    : undefined;
  const content = typeof msg.content === "string" && msg.content.length ? msg.content : null;
  return { role: "assistant", content, ...(calls ? { tool_calls: calls } : {}), usage };
}

async function readSse(res: Response, ep: LlmEndpoint, onDelta: (text: string) => void): Promise<ChatMessage> {
  if (!res.body) throw new Error(`${ep.name} stream had no body`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  let usage: TokenUsage | undefined;
  const calls = new Map<number, { id: string; name: string; args: string; extra?: unknown }>();
  const handle = (chunk: any) => {
    if (chunk?.usage) usage = usageFromOpenAI(chunk.usage);
    const delta = chunk?.choices?.[0]?.delta;
    if (!delta) return;
    if (typeof delta.content === "string" && delta.content) {
      text += delta.content;
      onDelta(delta.content);
    }
    for (const tc of delta.tool_calls ?? []) {
      const idx = Number(tc.index ?? 0);
      const cur = calls.get(idx) ?? { id: "", name: "", args: "" };
      if (tc.id) cur.id = String(tc.id);
      if (tc.function?.name) cur.name += String(tc.function.name);
      if (typeof tc.function?.arguments === "string") cur.args += tc.function.arguments;
      if (tc.extra_content !== undefined) cur.extra = tc.extra_content;
      calls.set(idx, cur);
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        handle(JSON.parse(data));
      } catch {
        /* keep-alive or partial frame */
      }
    }
  }
  if (!text && !calls.size) throw new Error(`${ep.name} stream ended with no content`);
  const toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([i, c]) => ({ id: c.id || `call_${i}`, type: "function" as const, function: { name: c.name, arguments: c.args || "{}" }, ...(c.extra !== undefined ? { extra_content: c.extra } : {}) }));
  return { role: "assistant", content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}), usage: usage ?? { input: 0, output: 0, cache_read: 0, cache_write: 0 } };
}
