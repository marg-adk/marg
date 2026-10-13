/**
 * env.ts — minimal .env loader + repo-root locator + typed env readers.
 *
 * MUST be the first import of any entrypoint (gateway, MCP server, scripts) so
 * process.env is populated before config modules capture it. Walks up from this
 * file until it finds the repo root (a package.json declaring workspaces, or a
 * .git dir), so it works however deep the caller lives.
 *
 * Every Marg setting is `AGENT_<NAME>`; model endpoints are `LLM_<NAME>_*`;
 * decisions are `VERDICT_*`. The helpers below read them with their defaults.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        if (JSON.parse(readFileSync(pkg, "utf8")).workspaces) return dir;
      } catch {
        /* malformed package.json — keep walking */
      }
    }
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

const repoRoot = process.env.AGENT_REPO_ROOT ?? findRepoRoot(dirname(fileURLToPath(import.meta.url)));

try {
  const raw = readFileSync(join(repoRoot, ".env"), "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {
  /* no .env — rely on the real environment */
}

/** The monorepo root (where package.json with workspaces lives). */
export const REPO_ROOT = repoRoot;

/** A positive number from the environment, else the fallback. */
export const envNum = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
/** A non-negative number (0 allowed) from the environment, else the fallback. */
export const envNum0 = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
};
/** `true` only when the variable is the literal string "true" (safety flags must be deliberate). */
export const envTrue = (name: string): boolean => process.env[name] === "true";
/** `false` only when the variable is the literal "false" (features that are on unless switched off). */
export const envNotFalse = (name: string): boolean => process.env[name] !== "false";
/** A comma-separated list, trimmed, empties dropped. */
export const envList = (name: string): string[] =>
  (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
