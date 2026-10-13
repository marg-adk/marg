/**
 * @marg-adk/verdict — typed decisions for agents.
 *
 * A DECISION is a typed question about a state, answered with a probability distribution, not
 * prose: "which department?" (choice), "is this urgent?" (noul: a yes/no with P(true)), "how
 * severe, 1–5?" (score). Agents need thousands of these — routing a message to a domain, reading
 * whether a reply is a confirmation, checking a safety condition before a write — and a
 * generative model is the wrong tool for them: slow, expensive, uncalibrated and verbose.
 *
 * The contract below is the System One protocol (`POST /v1/systemone`) that Laya (Apache-2.0,
 * convaiinnovations/laya) and the proprietary Jev API both speak, so a Verdict backend can be a
 * local Laya checkpoint, a hosted decision model, deterministic rules, or an LLM with logprobs —
 * and the agent never knows which.
 */

export type NoulQuestion = { type: "noul"; instructions: string };
export type ChoiceQuestion = { type: "choice"; instructions: string; criteria: Record<string, string> };
export type ScoreQuestion = { type: "score"; instructions: string; criteria: string[] };
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type Questions = Record<string, Question>;

/** The thing judged: a text, or a structured object/array (serialised as JSON for text backends). */
export type State = string | Record<string, unknown> | unknown[];

export interface DecideRequest {
  state: State;
  questions: Questions;
  /** Below this confidence an answer is flagged `low_confidence` (choice/score may `abstain`). */
  min_confidence?: number;
  timeout_ms?: number;
}

export interface NoulAnswer {
  type: "noul";
  /** P(true), 0..1. */
  noul: number;
  /** How decided the answer is: |2p − 1|. Not the chance it is correct — calibrate on your own data. */
  confidence: number;
  low_confidence?: boolean;
}
export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  /** 1 − normalised entropy of the distribution (0 = uniform, 1 = certain). */
  confidence: number;
  low_confidence?: boolean;
  /** The answer fell below min_confidence and the caller asked for abstention. */
  abstained?: boolean;
}
export interface ScoreAnswer {
  type: "score";
  /** Probability-weighted level index (0-based, fractional). */
  score: number;
  /** The most probable level's label. */
  level: string;
  probabilities: Record<string, number>;
  confidence: number;
  low_confidence?: boolean;
}
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface DecideResult {
  answers: Record<string, Answer>;
  /** Which backend produced the answers ("rules", "systemone", "llm", "cascade"…). */
  backend: string;
  model?: string;
  ms: number;
  usage?: { input_tokens?: number; output_tokens?: number };
  /** With a cascade: which backend answered each question. */
  answered_by?: Record<string, string>;
}

export interface DecisionBackend {
  name: string;
  /**
   * Answer the questions (all of them, or the subset in `only`). A backend may answer FEWER
   * questions than asked (rules have no opinion on most) — a cascade fills the rest.
   */
  decide(req: DecideRequest, only?: string[]): Promise<DecideResult>;
  health?(): Promise<{ ok: boolean; detail?: string }>;
}

// ---- maths shared by every backend -------------------------------------------------

/** Normalise a positive vector into probabilities (uniform when all zero). */
export function normalise(p: Record<string, number>): Record<string, number> {
  const keys = Object.keys(p);
  const sum = keys.reduce((a, k) => a + Math.max(0, p[k] || 0), 0);
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = sum > 0 ? Math.max(0, p[k] || 0) / sum : 1 / keys.length;
  return out;
}

/** 1 − H(p)/log(n): 0 for a uniform distribution, 1 for a certain one. */
export function concentration(p: Record<string, number>): number {
  const vals = Object.values(p);
  const n = vals.length;
  if (n <= 1) return 1;
  let h = 0;
  for (const v of vals) if (v > 0) h -= v * Math.log(v);
  return Math.max(0, Math.min(1, 1 - h / Math.log(n)));
}

export function argmax(p: Record<string, number>): string {
  let best = "";
  let bv = -Infinity;
  for (const [k, v] of Object.entries(p)) {
    if (v > bv) {
      bv = v;
      best = k;
    }
  }
  return best;
}

/** Build the three answer shapes from a distribution. */
export function choiceAnswer(probabilities: Record<string, number>): ChoiceAnswer {
  const p = normalise(probabilities);
  return { type: "choice", choice: argmax(p), probabilities: p, confidence: concentration(p) };
}
export function noulAnswer(pTrue: number): NoulAnswer {
  const p = Math.max(0, Math.min(1, pTrue));
  return { type: "noul", noul: p, confidence: Math.abs(2 * p - 1) };
}
export function scoreAnswer(levels: string[], probabilities: Record<string, number>): ScoreAnswer {
  const p = normalise(Object.fromEntries(levels.map((l) => [l, probabilities[l] ?? 0])));
  const score = levels.reduce((a, l, i) => a + i * p[l], 0);
  return { type: "score", score, level: argmax(p), probabilities: p, confidence: concentration(p) };
}

/** Apply the min_confidence policy to an answer (flag, and abstain a choice). */
export function applyConfidencePolicy(a: Answer, minConfidence: number | undefined, abstain = true): Answer {
  if (minConfidence === undefined) return a;
  if (a.confidence >= minConfidence) return a;
  const flagged = { ...a, low_confidence: true } as Answer;
  if (flagged.type === "choice" && abstain) flagged.abstained = true;
  return flagged;
}

export function stateText(state: State): string {
  return typeof state === "string" ? state : JSON.stringify(state);
}
