/**
 * calibration.ts — is a 0.9 really a 0.9? Measure, then fix.
 *
 * A decision model's confidence is a statement about its own distribution, not about the world.
 * Before an agent acts on "confidence ≥ 0.8", measure it on YOUR labelled data: accuracy, Brier
 * score, expected calibration error (ECE), and the abstention rate a threshold would cause. Then
 * fit a temperature (one scalar per question) that makes the probabilities honest, and pick the
 * threshold that reaches the precision you need.
 */
import { argmax, normalise, type Answer } from "./types.js";

export interface LabelledSample {
  /** The probabilities the backend returned (choice/score), or {yes, no} for a noul. */
  probabilities: Record<string, number>;
  /** The correct key. */
  label: string;
}

/** Sharpen (T < 1) or soften (T > 1) a distribution. */
export function temperatureScale(probabilities: Record<string, number>, T: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, p] of Object.entries(probabilities)) out[k] = Math.pow(Math.max(p, 1e-12), 1 / Math.max(T, 1e-6));
  return normalise(out);
}

/** Negative log-likelihood of the labels under temperature T. */
function nll(samples: LabelledSample[], T: number): number {
  let s = 0;
  for (const x of samples) {
    const p = temperatureScale(x.probabilities, T)[x.label] ?? 1e-12;
    s -= Math.log(Math.max(p, 1e-12));
  }
  return s / Math.max(1, samples.length);
}

/** Grid-search the temperature that minimises NLL on the samples (0.2 … 5). */
export function fitTemperature(samples: LabelledSample[]): number {
  if (!samples.length) return 1;
  let best = 1;
  let bestV = nll(samples, 1);
  for (let T = 0.2; T <= 5.0001; T += 0.05) {
    const v = nll(samples, T);
    if (v < bestV - 1e-12) {
      bestV = v;
      best = +T.toFixed(2);
    }
  }
  return best;
}

export interface CalibrationReport {
  n: number;
  accuracy: number;
  brier: number;
  /** Expected calibration error over 10 equal-width confidence bins. */
  ece: number;
  mean_confidence: number;
  /** Accuracy among the samples kept, and the share abstained, at each candidate threshold. */
  thresholds: { min_confidence: number; kept: number; accuracy_kept: number; abstained_rate: number }[];
}

/** Confidence of a distribution as the top probability (what a threshold compares against). */
const topProb = (p: Record<string, number>): number => Math.max(...Object.values(p));

export function evaluate(samples: LabelledSample[], T = 1): CalibrationReport {
  const n = samples.length;
  if (!n) return { n: 0, accuracy: 0, brier: 0, ece: 0, mean_confidence: 0, thresholds: [] };
  const rows = samples.map((x) => {
    const p = temperatureScale(x.probabilities, T);
    const pred = argmax(p);
    const conf = topProb(p);
    const correct = pred === x.label;
    let brier = 0;
    for (const [k, v] of Object.entries(p)) brier += (v - (k === x.label ? 1 : 0)) ** 2;
    return { conf, correct, brier };
  });
  const accuracy = rows.filter((r) => r.correct).length / n;
  const brier = rows.reduce((a, r) => a + r.brier, 0) / n;
  const bins = Array.from({ length: 10 }, () => ({ n: 0, conf: 0, acc: 0 }));
  for (const r of rows) {
    const b = Math.min(9, Math.floor(r.conf * 10));
    bins[b].n++;
    bins[b].conf += r.conf;
    bins[b].acc += r.correct ? 1 : 0;
  }
  const ece = bins.reduce((a, b) => (b.n ? a + (b.n / n) * Math.abs(b.acc / b.n - b.conf / b.n) : a), 0);
  const thresholds = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95].map((t) => {
    const kept = rows.filter((r) => r.conf >= t);
    return { min_confidence: t, kept: kept.length, accuracy_kept: kept.length ? kept.filter((r) => r.correct).length / kept.length : 0, abstained_rate: 1 - kept.length / n };
  });
  return { n, accuracy, brier, ece, mean_confidence: rows.reduce((a, r) => a + r.conf, 0) / n, thresholds };
}

/** The lowest threshold whose kept-accuracy reaches `targetPrecision` (undefined when none does). */
export function fitAbstentionThreshold(samples: LabelledSample[], targetPrecision: number, T = 1): number | undefined {
  const report = evaluate(samples, T);
  return report.thresholds.find((t) => t.kept > 0 && t.accuracy_kept >= targetPrecision)?.min_confidence;
}

/** Per-question calibration: temperature and threshold, applied by the Decider. */
export interface Calibration {
  [questionId: string]: { temperature?: number; min_confidence?: number };
}

export function calibrateAnswer(a: Answer, cal?: { temperature?: number; min_confidence?: number }): Answer {
  if (!cal?.temperature || cal.temperature === 1) return a;
  if (a.type === "noul") {
    const p = temperatureScale({ yes: a.noul, no: 1 - a.noul }, cal.temperature);
    return { ...a, noul: p.yes, confidence: Math.abs(2 * p.yes - 1) };
  }
  const p = temperatureScale(a.probabilities, cal.temperature);
  const top = argmax(p);
  const conf = 1 - (-Object.values(p).reduce((s, v) => (v > 0 ? s + v * Math.log(v) : s), 0)) / Math.log(Math.max(2, Object.keys(p).length));
  if (a.type === "choice") return { ...a, probabilities: p, choice: top, confidence: conf };
  const levels = Object.keys(a.probabilities);
  return { ...a, probabilities: p, level: top, score: levels.reduce((s, l, i) => s + i * p[l], 0), confidence: conf };
}
