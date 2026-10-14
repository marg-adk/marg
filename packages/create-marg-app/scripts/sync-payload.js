/**
 * sync-payload.js — copy what a new project needs from the monorepo into payload/.
 *
 * WHAT COMES IN: ../../templates, ../../examples/support-intake, ../../shared-skills,
 *   ../../scripts/new-domain.ts, ../../.env.example (read from the monorepo, so it only runs there).
 * WHAT COMES OUT: payload/{templates,examples/support-intake,shared-skills,skills,scripts/new-domain.ts,env.example}
 *   — git-ignored, rebuilt by `npm run build` and on `prepack`, shipped in the tarball.
 * WHO TALKS TO IT: scripts/build.ts, npm (prepack), and nothing at install time.
 *
 * Skipped: node_modules, eval results, .DS_Store, and the example's own package.json (the new
 * project is not a workspace; the example runs from the project's dependencies).
 */
import { cpSync, existsSync, mkdirSync, rmSync, copyFileSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..");
const payload = resolve(here, "..", "payload");
if (!existsSync(join(repo, "templates")) || !existsSync(join(repo, "shared-skills"))) {
  console.error("sync-payload: not inside the Marg monorepo — nothing to sync");
  process.exit(1);
}
const SKIP = new Set(["node_modules", "results", ".DS_Store", "package.json"]);
const filter = (src) => !SKIP.has(basename(src));

rmSync(payload, { recursive: true, force: true });
mkdirSync(join(payload, "scripts"), { recursive: true });
mkdirSync(join(payload, "examples"), { recursive: true });
cpSync(join(repo, "templates"), join(payload, "templates"), { recursive: true, filter });
cpSync(join(repo, "examples", "support-intake"), join(payload, "examples", "support-intake"), { recursive: true, filter });
cpSync(join(repo, "shared-skills"), join(payload, "shared-skills"), { recursive: true, filter });
cpSync(join(repo, "skills"), join(payload, "skills"), { recursive: true, filter });
copyFileSync(join(repo, "scripts", "new-domain.ts"), join(payload, "scripts", "new-domain.ts"));
copyFileSync(join(repo, ".env.example"), join(payload, "env.example"));
console.log("sync-payload: payload/ rebuilt from the monorepo");
