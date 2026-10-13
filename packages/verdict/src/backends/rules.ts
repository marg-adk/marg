/**
 * backends/rules.ts — deterministic decisions: regex and predicate rules, free and instant.
 *
 * Rules answer the questions they have an opinion on and stay silent on the rest, so they sit
 * first in a cascade: a tapped chip value, a lexicon hit, a hard business rule never reaches a
 * model. A rule's confidence is what you give it (1.0 for a certain match); a rule that does not
 * match returns undefined and the cascade moves on.
 */
import { choiceAnswer, noulAnswer, scoreAnswer, stateText, type Answer, type DecideRequest, type DecideResult, type DecisionBackend, type Question, type State } from "../types.js";

export type Rule = (state: State, question: Question, questionId: string) => Answer | undefined | Promise<Answer | undefined>;

export interface RulesBackendOptions {
  /** Rules by question id ("*" applies to every question). A question's own rules run first. */
  rules: Record<string, Rule | Rule[]>;
  name?: string;
}

export function rulesBackend(opts: RulesBackendOptions): DecisionBackend {
  const list = (id: string): Rule[] => {
    const own = opts.rules[id];
    const any = opts.rules["*"];
    return [...(Array.isArray(own) ? own : own ? [own] : []), ...(Array.isArray(any) ? any : any ? [any] : [])];
  };
  return {
    name: opts.name ?? "rules",
    async decide(req: DecideRequest, only?: string[]): Promise<DecideResult> {
      const t0 = Date.now();
      const answers: Record<string, Answer> = {};
      for (const [id, q] of Object.entries(req.questions)) {
        if (only && !only.includes(id)) continue;
        for (const rule of list(id)) {
          const a = await rule(req.state, q, id);
          if (a) {
            answers[id] = a;
            break;
          }
        }
      }
      return { answers, backend: opts.name ?? "rules", ms: Date.now() - t0 };
    },
    async health() {
      return { ok: true };
    },
  };
}

// ---- rule builders ----------------------------------------------------------------------

/** A choice decided by the first option whose pattern matches the state text (whole-content: the state must match exactly one option). */
export function regexChoice(patterns: Record<string, RegExp>, opts: { confidence?: number; exclusive?: boolean } = {}): Rule {
  return (state, question) => {
    if (question.type !== "choice") return undefined;
    const text = stateText(state);
    const hits = Object.entries(patterns).filter(([k, re]) => k in question.criteria && re.test(text)).map(([k]) => k);
    if (!hits.length || (opts.exclusive !== false && hits.length > 1)) return undefined;
    const c = opts.confidence ?? 1;
    const probs: Record<string, number> = {};
    const others = Object.keys(question.criteria).filter((k) => k !== hits[0]);
    for (const k of Object.keys(question.criteria)) probs[k] = k === hits[0] ? c : others.length ? (1 - c) / others.length : 0;
    return choiceAnswer(probs);
  };
}

/** A yes/no decided by patterns: `yes` matching ⇒ P(true)=confidence; `no` matching ⇒ 1−confidence; both or neither ⇒ no opinion. */
export function regexNoul(yes: RegExp, no?: RegExp, confidence = 0.98): Rule {
  return (state, question) => {
    if (question.type !== "noul") return undefined;
    const text = stateText(state);
    const y = yes.test(text);
    const n = no ? no.test(text) : false;
    if (y && !n) return noulAnswer(confidence);
    if (n && !y) return noulAnswer(1 - confidence);
    return undefined;
  };
}

/** A predicate on the state: true ⇒ P(true)=confidence, false ⇒ 1−confidence, undefined ⇒ no opinion. */
export function predicateNoul(fn: (state: State) => boolean | undefined, confidence = 0.98): Rule {
  return (state, question) => {
    if (question.type !== "noul") return undefined;
    const v = fn(state);
    if (v === undefined) return undefined;
    return noulAnswer(v ? confidence : 1 - confidence);
  };
}

/** A score level decided by a function returning the level label (or undefined). */
export function levelRule(fn: (state: State) => string | undefined, confidence = 0.95): Rule {
  return (state, question) => {
    if (question.type !== "score") return undefined;
    const level = fn(state);
    if (!level || !question.criteria.includes(level)) return undefined;
    const probs: Record<string, number> = {};
    const others = question.criteria.length - 1;
    for (const l of question.criteria) probs[l] = l === level ? confidence : others ? (1 - confidence) / others : 0;
    return scoreAnswer(question.criteria, probs);
  };
}
