/**
 * cli.ts — ask a typed question from the shell.
 *
 *   npm run verdict -- "My payment failed twice and nobody answers" --choice department=billing,technical,sales
 *   npm run verdict -- "Hello there" --noul "Does the text contain a greeting?"
 *   npm run verdict -- "<text>" --score severity=low,medium,high,critical
 *   VERDICT_SYSTEMONE_URL=http://localhost:11434 npm run verdict -- "..." --choice ...   # Laya via Ollama
 *
 * Without a System One URL the CLI answers with the rules it has (none) and says so — the point
 * of the command is to try a decision model, not to invent answers.
 */
import { deciderFromEnv, verdictEnvSnapshot } from "./env.js";
import type { Questions } from "./types.js";

const argv = process.argv.slice(2);
const state = argv.find((a) => !a.startsWith("--")) ?? "";
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const questions: Questions = {};
const choice = arg("choice");
if (choice) {
  const [id, opts] = choice.split("=");
  questions[id ?? "choice"] = { type: "choice", instructions: arg("ask") ?? `Which ${id} fits the text best?`, criteria: Object.fromEntries((opts ?? "").split(",").map((o) => [o.trim(), o.trim()])) };
}
const noul = arg("noul");
if (noul) questions.noul = { type: "noul", instructions: noul };
const score = arg("score");
if (score) {
  const [id, levels] = score.split("=");
  questions[id ?? "score"] = { type: "score", instructions: arg("ask") ?? `Rate the ${id} of the text.`, criteria: (levels ?? "").split(",").map((s) => s.trim()) };
}
if (!state || !Object.keys(questions).length) {
  console.error('usage: verdict "<state text>" (--choice id=a,b,c | --noul "statement" | --score id=l1,l2,l3) [--ask "instructions"]');
  process.exit(2);
}
const { decider, links } = deciderFromEnv();
const env = verdictEnvSnapshot();
console.error(`backends: ${links.join(" → ") || "none"}${env.systemone ? ` (System One at ${env.systemone.url}, model ${env.systemone.model})` : " — set VERDICT_SYSTEMONE_URL to use a decision model"}`);
const res = await decider.decide(state, questions);
console.log(JSON.stringify(res, null, 2));
