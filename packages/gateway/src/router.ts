/**
 * router.ts — the super agent (ADR-0001): a thin router, not a doer.
 *
 * Each turn it picks ONE domain and delegates to that domain's agent, which runs in its own
 * context (its skills + its tools only). It owns no tools itself. Routing is sticky: it stays in
 * the current domain until intent clearly shifts. With a single installed domain the classifier
 * is skipped entirely (zero cost); a finished chat's turns never re-route.
 *
 * The classification is a TYPED DECISION (Verdict): a `choice` over the domain cards, answered by
 * the cascade — manifest keywords as rules first, a decision model (Laya) when configured, the
 * LLM with logprobs last. A low-confidence pick falls back to the active domain, then the first
 * domain — routing never throws, and a misroute degrades to a clarifying question, never a wrong write.
 */
import type { DomainManifest } from "@marg-adk/types";
import { chatComplete, counter, getSession, log, recordUsage, withSpan, type ChatMessage } from "@marg-adk/core";
import { deciderFromEnv, regexChoice, rulesBackend, type CompleteFn, type Decider, type TokenLogprobs } from "@marg-adk/verdict";
import { discoverDomains } from "./domains.js";

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The LLM link of the cascade: one short call through the model chain, logprobs when the endpoint gives them. */
export const llmComplete: CompleteFn = async (prompt, opts) => {
  const msg = await chatComplete([{ role: "system", content: "Answer with exactly one letter." }, { role: "user", content: prompt }], [], { maxTokens: Math.max(1, opts.maxTokens), modelNotes: false, temperature: 0, ...(opts.logprobs ? { body: { logprobs: true, top_logprobs: 20 } } : {}), spanAttributes: { "agent.hop": "decision" } });
  const lp = (msg as ChatMessage & { logprobs?: { content?: { top_logprobs?: { token: string; logprob: number }[] }[] } }).logprobs;
  let logprobs: TokenLogprobs | undefined;
  const first = lp?.content?.[0]?.top_logprobs;
  if (Array.isArray(first)) {
    logprobs = {};
    for (const t of first) if (typeof t?.token === "string" && typeof t?.logprob === "number") logprobs[t.token] = t.logprob;
  }
  return { text: msg.content ?? "", logprobs, model: msg.usage?.model, usage: { input_tokens: msg.usage?.input, output_tokens: msg.usage?.output } };
};

let decider: Decider | undefined;
let links: string[] = [];

/** Build the router's decider once from the installed domains (keyword rules) and the environment. */
export function initRouter(domains: DomainManifest[]): { links: string[] } {
  const patterns: Record<string, RegExp> = {};
  for (const d of domains) {
    const words = [...(d.route_hints?.keywords ?? [])].map((k) => escapeRe(k.toLowerCase()));
    if (words.length) patterns[d.name] = new RegExp(`(^|[^\\p{L}])(${words.join("|")})([^\\p{L}]|$)`, "iu");
  }
  const rules = rulesBackend({ rules: { domain: regexChoice(patterns, { confidence: 0.9 }) }, name: "keywords" });
  const built = deciderFromEnv({ rules, complete: llmComplete, onError: (b, e) => log.warn("decision backend failed", { backend: b, error: e.message }), onDecision: (_req, res) => counter("decisions_total", { description: "Typed decisions by backend" }).add(1, { backend: res.answered_by?.domain ?? res.backend, kind: "route" }) });
  decider = built.decider;
  links = built.links;
  return { links };
}

export function routerSnapshot() {
  return { links, sticky: true, single_domain_shortcut: true };
}

const CONFIDENT = Number(process.env.AGENT_ROUTER_MIN_CONFIDENCE ?? 0.35) || 0.35;

export async function classify(message: string, domains: DomainManifest[], activeDomain: string | undefined): Promise<DomainManifest> {
  if (!decider) initRouter(domains);
  return withSpan("router.classify", { attrs: { "agent.domains": domains.map((d) => d.name).join(","), ...(activeDomain ? { "agent.active_domain": activeDomain } : {}) } }, async (span) => {
    const criteria = Object.fromEntries(domains.map((d) => [d.name, `${d.title}: ${d.description}${d.route_hints?.examples?.length ? ` Examples: ${d.route_hints.examples.slice(0, 6).join("; ")}.` : ""}`]));
    let pick: DomainManifest | undefined;
    let confidence = 0;
    let by = "fallback";
    try {
      const res = await decider!.decide(message, { domain: { type: "choice", instructions: `Which domain should handle this message?${activeDomain ? ` The conversation is currently in "${activeDomain}"; stay there unless the message clearly belongs elsewhere.` : ""}`, criteria } });
      const a = res.answers.domain;
      if (a?.type === "choice") {
        confidence = a.confidence;
        by = res.answered_by?.domain ?? res.backend;
        // stickiness: the active domain keeps the turn unless another option clearly wins
        const active = activeDomain ? a.probabilities[activeDomain] ?? 0 : 0;
        const top = a.probabilities[a.choice] ?? 0;
        if (a.confidence >= CONFIDENT && !(activeDomain && a.choice !== activeDomain && top - active < 0.25)) pick = domains.find((d) => d.name === a.choice);
      }
    } catch (e) {
      log.warn("router decision failed — using the sticky fallback", { error: (e as Error).message });
    }
    const chosen = pick ?? domains.find((d) => d.name === activeDomain) ?? domains[0];
    span.setAttributes({ "agent.router.domain": chosen.name, "agent.router.confidence": +confidence.toFixed(3), "agent.router.by": by, "agent.router.fallback": !pick });
    return chosen;
  });
}

/** Resolve the session and the target domain for a turn. */
export async function routeTurn(sessionId: string, userMessage: string): Promise<{ session: NonNullable<ReturnType<typeof getSession>>; target: DomainManifest }> {
  const session = getSession(sessionId);
  if (!session) throw new Error("Unknown session — call /api/session first.");
  const domains = discoverDomains();
  if (domains.length === 0) throw new Error("No domain modules installed (domains/*/domain.json).");
  let target: DomainManifest;
  if (domains.length === 1) target = domains[0];
  else if ((session.completion || session.preview?.steps) && session.activeDomain && domains.some((d) => d.name === session.activeDomain)) target = domains.find((d) => d.name === session.activeDomain)!; // mid-journey or finished: never re-classify
  else {
    const before = { ...session.usage };
    target = await classify(userMessage, domains, session.activeDomain);
    void before;
    recordUsage(session, undefined);
  }
  return { session, target };
}
