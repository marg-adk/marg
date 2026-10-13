/**
 * scripts/build.ts — build every publishable package, in dependency order.
 *
 *   npm run build          (npm run clean removes the output)
 *
 * WHAT COMES IN: packages/*\/tsconfig.build.json (ESM + .d.ts to dist/), the root LICENSE.
 * WHAT COMES OUT: packages/<p>/dist, a LICENSE copy per package (both git-ignored), and the
 *   create-marg-app payload (templates, the example, shared skills, the scaffolder).
 * WHO TALKS TO IT: scripts/check-pack.sh, scripts/check-create.sh, the release workflow.
 *
 * Development never needs this: tsx runs the TypeScript sources through tsconfig.json paths.
 * The build exists so the packages can be published and installed from npm.
 */
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Dependency order: each package's .d.ts resolve through the previous ones' dist. */
const ORDER = ["types", "core", "verdict", "evals", "metering", "gateway"];
const WITH_LICENSE = [...ORDER, "widget", "create-marg-app"];

const t0 = Date.now();
for (const p of ORDER) {
  const dir = join(root, "packages", p);
  rmSync(join(dir, "dist"), { recursive: true, force: true });
  execFileSync("npm", ["run", "-s", "build"], { cwd: dir, stdio: "inherit" });
  if (!existsSync(join(dir, "dist", p === "gateway" ? "server.js" : "index.js"))) {
    console.error(`build: ${p} produced no entry point`);
    process.exit(1);
  }
}
for (const p of WITH_LICENSE) copyFileSync(join(root, "LICENSE"), join(root, "packages", p, "LICENSE"));
execFileSync("node", [join(root, "packages", "create-marg-app", "scripts", "sync-payload.js")], { stdio: "inherit" });
console.log(`build: ${ORDER.length} packages compiled, payload synced (${Math.round((Date.now() - t0) / 100) / 10}s)`);
