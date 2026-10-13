/**
 * systemone-server.ts — serve ANY Verdict backend over the System One protocol.
 *
 * `POST /v1/systemone {model?, state, questions}` and `/v1/systemone/batch {states, questions}`,
 * plus `GET /models` and `GET /healthz`. The same contract Laya and Jev speak, so a rules + LLM
 * cascade can stand in for a decision model behind the same URL (tests, air-gapped deployments,
 * a gradual migration). Zero dependencies — node:http only.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { DecisionBackend, Question, State } from "./types.js";

export interface SystemOneServerOptions {
  backend: DecisionBackend;
  /** Require `Authorization: Bearer <key>` when set. */
  apiKey?: string;
  model?: string;
  maxBodyBytes?: number;
}

function readJson(req: IncomingMessage, max: number): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > max) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function validQuestions(q: unknown): q is Record<string, Question> {
  if (!q || typeof q !== "object" || Array.isArray(q)) return false;
  for (const v of Object.values(q as Record<string, unknown>)) {
    const t = (v as { type?: string })?.type;
    if (t !== "noul" && t !== "choice" && t !== "score") return false;
    if (typeof (v as { instructions?: unknown }).instructions !== "string") return false;
    if (t === "choice" && (typeof (v as { criteria?: unknown }).criteria !== "object" || Object.keys((v as { criteria: object }).criteria).length < 2)) return false;
    if (t === "score" && (!Array.isArray((v as { criteria?: unknown }).criteria) || (v as { criteria: unknown[] }).criteria.length < 2)) return false;
  }
  return Object.keys(q as object).length > 0;
}

export function createSystemOneServer(opts: SystemOneServerOptions): Server {
  const model = opts.model ?? opts.backend.name;
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://local");
      if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/")) {
        const h = opts.backend.health ? await opts.backend.health() : { ok: true };
        return send(res, h.ok ? 200 : 503, { ok: h.ok, backend: opts.backend.name, detail: h.detail });
      }
      if (req.method === "GET" && url.pathname === "/models") return send(res, 200, { models: [{ name: model, backend: opts.backend.name }] });
      if (opts.apiKey && req.headers.authorization !== `Bearer ${opts.apiKey}`) return send(res, 401, { error: "unauthorized" });
      if (req.method === "POST" && url.pathname === "/v1/systemone") {
        const body = await readJson(req, opts.maxBodyBytes ?? 64 * 1024);
        if (!validQuestions(body.questions)) return send(res, 400, { error: "questions: a non-empty map of {type: noul|choice|score, instructions, criteria}" });
        if (body.state === undefined) return send(res, 400, { error: "state is required" });
        const r = await opts.backend.decide({ state: body.state as State, questions: body.questions, min_confidence: typeof body.min_confidence === "number" ? body.min_confidence : undefined });
        return send(res, 200, { model, answers: r.answers, usage: r.usage ?? {}, backend: r.backend, answered_by: r.answered_by });
      }
      if (req.method === "POST" && url.pathname === "/v1/systemone/batch") {
        const body = await readJson(req, (opts.maxBodyBytes ?? 64 * 1024) * 64);
        if (!validQuestions(body.questions) || !Array.isArray(body.states) || body.states.length > 64) return send(res, 400, { error: "states: 1–64 items; questions: a valid map" });
        const results = [];
        for (const state of body.states as State[]) results.push({ answers: (await opts.backend.decide({ state, questions: body.questions })).answers });
        return send(res, 200, { model, results });
      }
      send(res, 404, { error: "not found" });
    } catch (e) {
      send(res, 500, { error: (e as Error).message });
    }
  });
}
