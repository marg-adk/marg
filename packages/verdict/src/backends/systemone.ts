/**
 * backends/systemone.ts — a decision model over the System One protocol.
 *
 * `POST {url}/v1/systemone  {model, state, questions}` → `{answers: {id: {...}}, usage}`.
 * This is what Laya serves (`laya-serve`, or `ollama pull laya` on Ollama ≥ 0.40 at
 * http://localhost:11434) and what the Jev API speaks — so the same backend talks to a local
 * open-weight checkpoint or a hosted model. Limits to know: Laya's `choice`/`score` take 2–26
 * options (about 20 recommended), each question has a ~512-token budget shared by instructions,
 * options and state, request bodies up to 64 KiB. Batch: `/v1/systemone/batch` up to 64 states.
 *
 * Confidence from the server is kept when present; otherwise it is derived the same way every
 * Verdict backend does (concentration / |2p−1|), so a cascade compares like with like.
 */
import { applyConfidencePolicy, choiceAnswer, concentration, noulAnswer, normalise, scoreAnswer, type Answer, type DecideRequest, type DecideResult, type DecisionBackend, type Question, type State } from "../types.js";

export interface SystemOneOptions {
  /** Base URL of the server (Ollama: http://localhost:11434; laya-serve: http://localhost:8000). */
  url: string;
  /** Model name the server expects ("laya", "laya:421m-typed-decisions-mlx-fp16", …). */
  model?: string;
  apiKey?: string;
  /** Path of the decision endpoint (default /v1/systemone). */
  path?: string;
  timeoutMs?: number;
  /** Extra headers (a hosted provider's own auth). */
  headers?: Record<string, string>;
  name?: string;
  /** Hard cap on how many states a batch call sends per request (protocol limit 64). */
  batchSize?: number;
}

function toServerAnswer(q: Question, raw: any): Answer | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  if (q.type === "noul") {
    const p = Number(raw.noul ?? raw.probability ?? raw.p_true);
    if (!Number.isFinite(p)) return undefined;
    const a = noulAnswer(p);
    if (typeof raw.confidence === "number") a.confidence = raw.confidence;
    return a;
  }
  if (q.type === "choice") {
    const probs = raw.probabilities && typeof raw.probabilities === "object" ? (raw.probabilities as Record<string, number>) : raw.choice ? { [String(raw.choice)]: 1 } : undefined;
    if (!probs) return undefined;
    const full: Record<string, number> = {};
    for (const k of Object.keys(q.criteria)) full[k] = Number(probs[k] ?? 0) || 0;
    const a = choiceAnswer(full);
    if (raw.choice && raw.choice in q.criteria) a.choice = String(raw.choice);
    if (typeof raw.confidence === "number") a.confidence = raw.confidence;
    return a;
  }
  const probs = raw.probabilities && typeof raw.probabilities === "object" ? (raw.probabilities as Record<string, number>) : undefined;
  if (!probs) return undefined;
  // a server may key level probabilities by index or by label
  const byLabel: Record<string, number> = {};
  q.criteria.forEach((l, i) => (byLabel[l] = Number(probs[l] ?? probs[String(i)] ?? probs[String(i + 1)] ?? 0) || 0));
  const a = scoreAnswer(q.criteria, byLabel);
  if (typeof raw.confidence === "number") a.confidence = raw.confidence;
  if (typeof raw.score === "number") a.score = raw.score;
  return a;
}

export function systemOneBackend(opts: SystemOneOptions): DecisionBackend {
  const base = opts.url.replace(/\/+$/, "");
  const path = opts.path ?? "/v1/systemone";
  const model = opts.model ?? "laya";
  const headers = { "Content-Type": "application/json", ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}), ...(opts.headers ?? {}) };
  const timeout = opts.timeoutMs ?? 15_000;
  const name = opts.name ?? "systemone";

  async function post(body: unknown, p = path): Promise<any> {
    const res = await fetch(`${base}${p}`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${name} HTTP ${res.status}: ${text.slice(0, 300)}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${name} returned non-JSON: ${text.slice(0, 200)}`);
    }
  }

  return {
    name,
    async decide(req: DecideRequest, only?: string[]): Promise<DecideResult> {
      const t0 = Date.now();
      const questions: Record<string, Question> = {};
      for (const [id, q] of Object.entries(req.questions)) if (!only || only.includes(id)) questions[id] = q;
      if (!Object.keys(questions).length) return { answers: {}, backend: name, model, ms: 0 };
      const body = await post({ model, state: req.state, questions, ...(req.min_confidence !== undefined ? { min_confidence: req.min_confidence } : {}) });
      const answers: Record<string, Answer> = {};
      for (const [id, q] of Object.entries(questions)) {
        const a = toServerAnswer(q, body?.answers?.[id]);
        if (a) answers[id] = applyConfidencePolicy(a, req.min_confidence);
      }
      return { answers, backend: name, model: String(body?.model ?? model), ms: Date.now() - t0, usage: body?.usage };
    },
    async health() {
      try {
        const r = await fetch(`${base}/`, { signal: AbortSignal.timeout(3000) }).catch(() => fetch(`${base}/models`, { signal: AbortSignal.timeout(3000) }));
        return { ok: r.ok || r.status === 404, detail: `HTTP ${r.status}` };
      } catch (e) {
        return { ok: false, detail: (e as Error).message };
      }
    },
  };
}

/** Decide the same questions for many states in one request (`/v1/systemone/batch`). */
export async function systemOneBatch(opts: SystemOneOptions, states: State[], questions: Record<string, Question>): Promise<DecideResult[]> {
  const backend = systemOneBackend({ ...opts, path: (opts.path ?? "/v1/systemone") + "/batch" });
  const size = Math.min(64, opts.batchSize ?? 64);
  const out: DecideResult[] = [];
  for (let i = 0; i < states.length; i += size) {
    const chunk = states.slice(i, i + size);
    const res = await fetch(`${opts.url.replace(/\/+$/, "")}${(opts.path ?? "/v1/systemone") + "/batch"}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}), ...(opts.headers ?? {}) },
      body: JSON.stringify({ model: opts.model ?? "laya", states: chunk, questions }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
    if (!res.ok) throw new Error(`${backend.name} batch HTTP ${res.status}`);
    const body: any = await res.json();
    const results: any[] = Array.isArray(body?.results) ? body.results : Array.isArray(body) ? body : [];
    for (const r of results) {
      const answers: Record<string, Answer> = {};
      for (const [id, q] of Object.entries(questions)) {
        const a = toServerAnswer(q, r?.answers?.[id]);
        if (a) answers[id] = a;
      }
      out.push({ answers, backend: backend.name, model: opts.model ?? "laya", ms: 0 });
    }
  }
  return out;
}

export { concentration, normalise };
