/**
 * backends/llm.ts — a generative model as a decision backend, with real probabilities when the
 * endpoint exposes logprobs (OpenAI-compatible servers: vLLM, llama.cpp, Ollama, OpenAI…).
 *
 * Each question becomes one short prompt that must be answered with a single option letter.
 * With `top_logprobs` on the first generated token, the letters' log-probabilities give a true
 * distribution (softmax over the option letters). Without logprobs the parsed letter becomes a
 * one-hot answer at a fixed, honest confidence (`uncalibrated`), so a cascade can still rank it.
 *
 * This is the last resort of a cascade: it costs a model call per question. The point of Verdict
 * is that rules and a decision model answer most questions before this runs.
 */
import { applyConfidencePolicy, choiceAnswer, noulAnswer, scoreAnswer, stateText, type Answer, type DecideRequest, type DecideResult, type DecisionBackend, type Question, type State } from "../types.js";

/** What the backend needs from a model: text in, text (+ optional first-token logprobs) out. */
export type CompleteFn = (prompt: string, opts: { maxTokens: number; logprobs: boolean }) => Promise<{ text: string; logprobs?: TokenLogprobs; model?: string; usage?: { input_tokens?: number; output_tokens?: number } }>;

/** First-token alternatives: token text → logprob. */
export type TokenLogprobs = Record<string, number>;

export interface LlmBackendOptions {
  complete: CompleteFn;
  name?: string;
  /** Confidence given to a parsed answer when no logprobs are available (default 0.55). */
  uncalibratedConfidence?: number;
  /** Ask for logprobs (default true). */
  logprobs?: boolean;
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function optionsOf(q: Question): { letter: string; key: string; text: string }[] {
  if (q.type === "noul") return [{ letter: "A", key: "yes", text: "Yes — the statement is true" }, { letter: "B", key: "no", text: "No — the statement is false" }];
  if (q.type === "choice") return Object.entries(q.criteria).slice(0, 26).map(([key, text], i) => ({ letter: LETTERS[i], key, text }));
  return q.criteria.slice(0, 26).map((text, i) => ({ letter: LETTERS[i], key: text, text }));
}

export function decisionPrompt(state: State, q: Question): string {
  const opts = optionsOf(q);
  const kind = q.type === "noul" ? "Decide whether the statement about the STATE is true." : q.type === "choice" ? "Pick the ONE option that best fits the STATE." : "Place the STATE on the ONE level that fits best.";
  return [
    "You are a decision function. Answer with exactly one letter and nothing else.",
    "",
    "STATE:",
    stateText(state).slice(0, 6000),
    "",
    "QUESTION: " + q.instructions,
    kind,
    "",
    ...opts.map((o) => `${o.letter}. ${o.text}`),
    "",
    "Answer (one letter):",
  ].join("\n");
}

/** Softmax over the option letters found in the first-token logprobs; undefined when none appear. */
export function probsFromLogprobs(lp: TokenLogprobs | undefined, opts: { letter: string; key: string }[]): Record<string, number> | undefined {
  if (!lp) return undefined;
  const found: Record<string, number> = {};
  for (const [tok, v] of Object.entries(lp)) {
    const t = tok.trim().replace(/[^A-Za-z]/g, "").toUpperCase();
    const o = opts.find((x) => x.letter === t);
    if (o && (found[o.key] === undefined || v > found[o.key])) found[o.key] = v;
  }
  if (!Object.keys(found).length) return undefined;
  const max = Math.max(...Object.values(found));
  const probs: Record<string, number> = {};
  let sum = 0;
  for (const o of opts) {
    const v = found[o.key];
    probs[o.key] = v === undefined ? 0 : Math.exp(v - max);
    sum += probs[o.key];
  }
  for (const k of Object.keys(probs)) probs[k] = sum ? probs[k] / sum : 1 / opts.length;
  return probs;
}

export function llmBackend(o: LlmBackendOptions): DecisionBackend {
  const name = o.name ?? "llm";
  const unc = o.uncalibratedConfidence ?? 0.55;
  return {
    name,
    async decide(req: DecideRequest, only?: string[]): Promise<DecideResult> {
      const t0 = Date.now();
      const answers: Record<string, Answer> = {};
      let model: string | undefined;
      const usage = { input_tokens: 0, output_tokens: 0 };
      for (const [id, q] of Object.entries(req.questions)) {
        if (only && !only.includes(id)) continue;
        const opts = optionsOf(q);
        const out = await o.complete(decisionPrompt(req.state, q), { maxTokens: 3, logprobs: o.logprobs !== false });
        model = out.model ?? model;
        usage.input_tokens += out.usage?.input_tokens ?? 0;
        usage.output_tokens += out.usage?.output_tokens ?? 0;
        let probs = probsFromLogprobs(out.logprobs, opts);
        if (!probs) {
          const letter = out.text.trim().replace(/[^A-Za-z]/g, "").toUpperCase().charAt(0);
          const hit = opts.find((x) => x.letter === letter);
          if (!hit) continue; // no answer: the cascade (or the caller) decides what to do
          probs = {};
          for (const x of opts) probs[x.key] = x.key === hit.key ? unc : (1 - unc) / Math.max(1, opts.length - 1);
        }
        let a: Answer;
        if (q.type === "noul") a = noulAnswer(probs.yes ?? 0);
        else if (q.type === "choice") a = choiceAnswer(probs);
        else a = scoreAnswer(q.criteria, probs);
        answers[id] = applyConfidencePolicy(a, req.min_confidence);
      }
      return { answers, backend: name, model, ms: Date.now() - t0, usage };
    },
    async health() {
      return { ok: true, detail: "depends on the model chain" };
    },
  };
}
