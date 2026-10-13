/**
 * env.ts — build the default Verdict cascade from the environment.
 *
 *   VERDICT_SYSTEMONE_URL      a System One server (Laya via Ollama or laya-serve, or Jev)
 *   VERDICT_SYSTEMONE_MODEL    model name (default "laya")
 *   VERDICT_SYSTEMONE_API_KEY  bearer for the server, when it needs one
 *   VERDICT_MIN_CONFIDENCE     default abstention threshold (0.6 when unset)
 *   VERDICT_ESCALATE_BELOW     a decision-model answer below this escalates to the LLM (0.5)
 *   VERDICT_LLM                "off" disables the LLM link (then only rules + the decision model answer)
 *
 * The caller supplies the rules (free, first) and the LLM completion function (last); the
 * decision model sits between them when configured.
 */
import { cascade } from "./cascade.js";
import { Decider, type DeciderOptions } from "./decider.js";
import { llmBackend, type CompleteFn } from "./backends/llm.js";
import { systemOneBackend } from "./backends/systemone.js";
import type { DecisionBackend } from "./types.js";

export interface DeciderFromEnvOptions {
  rules?: DecisionBackend;
  complete?: CompleteFn;
  calibration?: DeciderOptions["calibration"];
  onDecision?: DeciderOptions["onDecision"];
  onError?: (backend: string, error: Error) => void;
}

export function verdictEnvSnapshot() {
  const url = process.env.VERDICT_SYSTEMONE_URL ?? "";
  return {
    systemone: url ? { url, model: process.env.VERDICT_SYSTEMONE_MODEL ?? "laya", key_set: Boolean(process.env.VERDICT_SYSTEMONE_API_KEY) } : null,
    min_confidence: Number(process.env.VERDICT_MIN_CONFIDENCE ?? 0.6) || 0.6,
    escalate_below: Number(process.env.VERDICT_ESCALATE_BELOW ?? 0.5) || 0.5,
    llm: process.env.VERDICT_LLM !== "off",
  };
}

/** The decider the gateway uses: rules → System One (when configured) → LLM (when given). */
export function deciderFromEnv(o: DeciderFromEnvOptions = {}): { decider: Decider; links: string[] } {
  const env = verdictEnvSnapshot();
  const links: DecisionBackend[] = [];
  if (o.rules) links.push(o.rules);
  if (env.systemone) links.push(systemOneBackend({ url: env.systemone.url, model: env.systemone.model, apiKey: process.env.VERDICT_SYSTEMONE_API_KEY }));
  if (o.complete && env.llm) links.push(llmBackend({ complete: o.complete }));
  const backend = cascade(links, { escalateBelow: env.escalate_below, onError: o.onError });
  return { decider: new Decider({ backend, calibration: o.calibration, minConfidence: env.min_confidence, onDecision: o.onDecision }), links: links.map((l) => l.name) };
}
