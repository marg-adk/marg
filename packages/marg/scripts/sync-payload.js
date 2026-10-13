/**
 * sync-payload.js — copy the templates `marg new` scaffolds from into payload/ (git-ignored).
 * Runs from the monorepo only: scripts/build.ts and npm's prepack. Nothing runs at install time.
 */
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..");
const payload = resolve(here, "..", "payload");
if (!existsSync(join(repo, "templates"))) {
  console.error("sync-payload: not inside the Marg monorepo — nothing to sync");
  process.exit(1);
}
rmSync(payload, { recursive: true, force: true });
cpSync(join(repo, "templates"), join(payload, "templates"), { recursive: true, filter: (p) => basename(p) !== ".DS_Store" });
console.log("sync-payload (marg): payload/templates rebuilt");
