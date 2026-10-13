/**
 * cascade.ts — ask the cheap, certain backends first; escalate only what they cannot answer.
 *
 *   rules → decision model (Laya / System One) → LLM
 *
 * Each question travels down the chain until a backend answers it with confidence ≥ the
 * threshold (default: any answer). A backend that throws is skipped (and counted); a cascade
 * never throws because one link is down — it returns what it has, and `answered_by` says who
 * answered what. Low-confidence answers from an earlier link are kept as a fallback when every
 * later link stays silent.
 */
import type { Answer, DecideRequest, DecideResult, DecisionBackend } from "./types.js";

export interface CascadeOptions {
  /** An answer below this confidence escalates to the next backend (default 0: any answer stops). */
  escalateBelow?: number;
  name?: string;
  /** Called when a backend throws (telemetry); the cascade carries on. */
  onError?: (backend: string, error: Error) => void;
  /** Stop escalating after this backend index for these question ids (e.g. the LLM must never read a create-gate reply). */
  maxDepth?: Record<string, number>;
}

export function cascade(backends: DecisionBackend[], opts: CascadeOptions = {}): DecisionBackend {
  const threshold = opts.escalateBelow ?? 0;
  return {
    name: opts.name ?? "cascade",
    async decide(req: DecideRequest, only?: string[]): Promise<DecideResult> {
      const t0 = Date.now();
      const ids = Object.keys(req.questions).filter((id) => !only || only.includes(id));
      const answers: Record<string, Answer> = {};
      const answeredBy: Record<string, string> = {};
      const fallback: Record<string, { a: Answer; by: string }> = {};
      let pending = ids.slice();
      let model: string | undefined;
      for (let i = 0; i < backends.length && pending.length; i++) {
        const b = backends[i];
        const askable = pending.filter((id) => (opts.maxDepth?.[id] ?? Infinity) >= i);
        if (!askable.length) break;
        let res: DecideResult;
        try {
          res = await b.decide(req, askable);
        } catch (e) {
          opts.onError?.(b.name, e as Error);
          continue;
        }
        model = res.model ?? model;
        for (const id of askable) {
          const a = res.answers[id];
          if (!a) continue;
          if (a.confidence >= threshold) {
            answers[id] = a;
            answeredBy[id] = b.name;
            pending = pending.filter((x) => x !== id);
          } else if (!fallback[id] || fallback[id].a.confidence < a.confidence) {
            fallback[id] = { a, by: b.name };
          }
        }
      }
      for (const id of pending) {
        if (fallback[id]) {
          answers[id] = { ...fallback[id].a, low_confidence: true };
          answeredBy[id] = fallback[id].by;
        }
      }
      return { answers, backend: opts.name ?? "cascade", model, ms: Date.now() - t0, answered_by: answeredBy };
    },
    async health() {
      const states = await Promise.all(backends.map(async (b) => ({ name: b.name, ...(b.health ? await b.health() : { ok: true }) })));
      return { ok: states.some((s) => s.ok), detail: states.map((s) => `${s.name}:${s.ok ? "ok" : "down"}`).join(" ") };
    },
  };
}
