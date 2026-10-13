/**
 * env.ts — minimal .env loader + repo-root locator + typed env readers.
 *
 * MUST be the first import of any entrypoint (gateway, MCP server, scripts) so
 * process.env is populated before config modules capture it.
 *
 * THE PROJECT ROOT (REPO_ROOT): where .env, domains/, examples/ and shared-skills/ live.
 *  - In this monorepo: walk up from this file to the package.json declaring workspaces (or a
 *    .git dir), so it works however deep the caller lives.
 *  - Installed from npm (this file sits under node_modules/): the project is where the process
 *    runs — walk up from the working directory to the nearest package.json or .git.
 *  - AGENT_REPO_ROOT overrides both.
 *
 * Every Marg setting is `AGENT_<NAME>`; model endpoints are `LLM_<NAME>_*`;
 * decisions are `VERDICT_*`. The helpers below read them with their defaults.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Walk up from `start` to the first directory `isRoot` accepts; null when none within 12 levels. */
function walkUp(start: string, isRoot: (dir: string) => boolean): string | null {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    if (isRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
const hasPackageJson = (dir: string, needWorkspaces: boolean): boolean => {
  const pkg = join(dir, "package.json");
  if (!existsSync(pkg)) return false;
  if (!needWorkspaces) return true;
  try {
    return Boolean(JSON.parse(readFileSync(pkg, "utf8")).workspaces);
  } catch {
    return false; // malformed package.json — keep walking
  }
};
const isGitDir = (dir: string): boolean => existsSync(join(dir, ".git"));

function locateRoot(): string {
  if (process.env.AGENT_REPO_ROOT) return process.env.AGENT_REPO_ROOT;
  const here = dirname(fileURLToPath(import.meta.url));
  if (here.split(sep).includes("node_modules")) {
    const cwd = process.cwd();
    return walkUp(cwd, (d) => hasPackageJson(d, false) || isGitDir(d)) ?? cwd;
  }
  return walkUp(here, (d) => hasPackageJson(d, true) || isGitDir(d)) ?? here;
}

const repoRoot = locateRoot();

try {
  const raw = readFileSync(join(repoRoot, ".env"), "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {
  /* no .env — rely on the real environment */
}

/** The project root: the monorepo root here, the user's project when installed from npm (see the header). */
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
