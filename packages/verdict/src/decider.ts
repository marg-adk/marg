/**
 * decider.ts — the facade an agent calls: `decider.choose(...)`, `decider.yesNo(...)`,
 * `decider.score(...)`, or the raw `decide(state, questions)`. Applies per-question calibration
 * and the min_confidence policy on top of whatever backend (usually a cascade) answers.
 */
import { calibrateAnswer, type Calibration } from "./calibration.js";
import { applyConfidencePolicy, type Answer, type ChoiceAnswer, type DecideRequest, type DecideResult, type DecisionBackend, type NoulAnswer, type Questions, type ScoreAnswer, type State } from "./types.js";

export interface DeciderOptions {
  backend: DecisionBackend;
  calibration?: Calibration;
  /** Default min_confidence applied to every question (a question's own calibration overrides it). */
  minConfidence?: number;
  /** Observe every decision (telemetry). */
  onDecision?: (req: DecideRequest, res: DecideResult) => void;
}

export class Decider {
  constructor(private readonly o: DeciderOptions) {}

  get backend(): DecisionBackend {
    return this.o.backend;
  }

  async decide(state: State, questions: Questions, opts: { min_confidence?: number; timeout_ms?: number } = {}): Promise<DecideResult> {
    const req: DecideRequest = { state, questions, min_confidence: opts.min_confidence ?? this.o.minConfidence, timeout_ms: opts.timeout_ms };
    const res = await this.o.backend.decide(req);
    const answers: Record<string, Answer> = {};
    for (const [id, a] of Object.entries(res.answers)) {
      const cal = this.o.calibration?.[id];
      const calibrated = calibrateAnswer(a, cal);
      const threshold = cal?.min_confidence ?? req.min_confidence;
      answers[id] = applyConfidencePolicy({ ...calibrated, low_confidence: undefined, abstained: undefined } as Answer, threshold);
    }
    const out = { ...res, answers };
    this.o.onDecision?.(req, out);
    return out;
  }

  /** One choice question. */
  async choose(state: State, instructions: string, criteria: Record<string, string>, opts?: { min_confidence?: number }): Promise<ChoiceAnswer | undefined> {
    const r = await this.decide(state, { q: { type: "choice", instructions, criteria } }, opts);
    return r.answers.q as ChoiceAnswer | undefined;
  }
  /** One yes/no question → P(true). */
  async yesNo(state: State, instructions: string, opts?: { min_confidence?: number }): Promise<NoulAnswer | undefined> {
    const r = await this.decide(state, { q: { type: "noul", instructions } }, opts);
    return r.answers.q as NoulAnswer | undefined;
  }
  /** One ordinal question. */
  async score(state: State, instructions: string, levels: string[], opts?: { min_confidence?: number }): Promise<ScoreAnswer | undefined> {
    const r = await this.decide(state, { q: { type: "score", instructions, criteria: levels } }, opts);
    return r.answers.q as ScoreAnswer | undefined;
  }

  /**
   * Schema-shaped decisions: a JSON-schema-like object whose properties are enums (choice),
   * booleans (noul) or bounded integers (score). Returns the values projected onto the schema plus
   * each field's answer.
   */
  async decideSchema(state: State, schema: { properties: Record<string, SchemaField> }, opts?: { min_confidence?: number }): Promise<{ values: Record<string, unknown>; answers: Record<string, Answer> }> {
    const questions: Questions = {};
    for (const [key, f] of Object.entries(schema.properties)) {
      const instructions = f.description ?? `What is "${key}"?`;
      if (f.enum?.length) questions[key] = { type: "choice", instructions, criteria: Object.fromEntries(f.enum.map((v) => [String(v), String(v)])) };
      else if (f.type === "boolean") questions[key] = { type: "noul", instructions };
      else if (f.type === "integer" && f.minimum !== undefined && f.maximum !== undefined && f.maximum - f.minimum <= 25) {
        questions[key] = { type: "score", instructions, criteria: Array.from({ length: f.maximum - f.minimum + 1 }, (_, i) => String(f.minimum! + i)) };
      }
    }
    const r = await this.decide(state, questions, opts);
    const values: Record<string, unknown> = {};
    for (const [key, a] of Object.entries(r.answers)) {
      if (a.type === "choice") values[key] = a.choice;
      else if (a.type === "noul") values[key] = a.noul >= 0.5;
      else values[key] = Number(a.level);
    }
    return { values, answers: r.answers };
  }
}

export interface SchemaField {
  type?: "string" | "boolean" | "integer";
  enum?: (string | number)[];
  description?: string;
  minimum?: number;
  maximum?: number;
}
