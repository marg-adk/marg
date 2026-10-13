/**
 * backends/mock.ts — scripted answers for tests and offline runs.
 */
import { applyConfidencePolicy, choiceAnswer, noulAnswer, scoreAnswer, type Answer, type DecideRequest, type DecideResult, type DecisionBackend, type Question, type State } from "../types.js";

export type MockAnswerer = (state: State, question: Question, id: string) => Answer | number | string | undefined;

/**
 * A backend whose answers come from a function (or a fixed map by question id). A number answers
 * a noul (P(true)); a string answers a choice/score (one-hot at 0.9); an Answer is used as is.
 */
export function mockBackend(script: MockAnswerer | Record<string, Answer | number | string>, name = "mock"): DecisionBackend {
  const fn: MockAnswerer = typeof script === "function" ? script : (_s, _q, id) => script[id];
  return {
    name,
    async decide(req: DecideRequest, only?: string[]): Promise<DecideResult> {
      const answers: Record<string, Answer> = {};
      for (const [id, q] of Object.entries(req.questions)) {
        if (only && !only.includes(id)) continue;
        const raw = fn(req.state, q, id);
        if (raw === undefined) continue;
        let a: Answer;
        if (typeof raw === "number") a = noulAnswer(raw);
        else if (typeof raw === "string") {
          if (q.type === "choice") a = choiceAnswer(Object.fromEntries(Object.keys(q.criteria).map((k) => [k, k === raw ? 0.9 : 0.1 / Math.max(1, Object.keys(q.criteria).length - 1)])));
          else if (q.type === "score") a = scoreAnswer(q.criteria, Object.fromEntries(q.criteria.map((l) => [l, l === raw ? 0.9 : 0.1 / Math.max(1, q.criteria.length - 1)])));
          else a = noulAnswer(/^(yes|true|1)$/i.test(raw) ? 0.95 : 0.05);
        } else a = raw;
        answers[id] = applyConfidencePolicy(a, req.min_confidence);
      }
      return { answers, backend: name, ms: 0 };
    },
    async health() {
      return { ok: true };
    },
  };
}
