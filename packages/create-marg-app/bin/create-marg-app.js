#!/usr/bin/env node
/**
 * create-marg-app — a fresh Marg project in one command.
 *
 *   npx create-marg-app my-agent
 *   cd my-agent && npm install && npm run gateway      # http://localhost:8787
 *
 * WHAT COMES IN: a folder name (kebab-case; "." for the current empty folder).
 * WHAT COMES OUT: <name>/ with package.json (depending on the published @marg packages at this
 *   tool's own version), tsconfig.json, .gitignore, .env (from .env.example, the mock model),
 *   README.md, templates/, examples/support-intake/, shared-skills/, scripts/new-domain.ts.
 *   Refuses a non-empty folder. Nothing is installed or run.
 * WHO TALKS TO IT: a developer, once per project. Then `npm run gateway`, `npm run new-domain`.
 *
 * CREATE_MARG_APP_PACKS=<dir> (the repository's own check) points the dependencies at local
 * tarballs (marg-<name>-<version>.tgz) instead of the registry.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const self = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
const payload = join(here, "..", "payload");
const projectFiles = join(here, "..", "project");

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith("-"));
if (!target || args.includes("--help") || args.includes("-h")) {
  console.log(`usage: npx create-marg-app <folder>\n\n  Creates a Marg project: the example domain, templates, shared skills and the scaffolder,\n  depending on @marg/* ${self.version}. Then: cd <folder> && npm install && npm run gateway`);
  process.exit(target ? 0 : 2);
}
const dest = resolve(process.cwd(), target);
const name = target === "." ? basename(dest) : basename(target);
if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
  console.error(`create-marg-app: "${name}" is not a valid package folder name (lowercase letters, digits, . _ -)`);
  process.exit(2);
}
if (existsSync(dest) && readdirSync(dest).some((f) => f !== ".git" && f !== ".DS_Store")) {
  console.error(`create-marg-app: ${dest} is not empty — refusing to overwrite`);
  process.exit(1);
}
if (!existsSync(join(payload, "templates"))) {
  console.error("create-marg-app: payload missing — in the Marg repository run `npm run build` first");
  process.exit(1);
}

mkdirSync(dest, { recursive: true });
cpSync(payload, dest, { recursive: true, filter: (src) => basename(src) !== "env.example" });
copyFileSync(join(payload, "env.example"), join(dest, ".env.example"));
copyFileSync(join(payload, "env.example"), join(dest, ".env"));
copyFileSync(join(projectFiles, "tsconfig.json"), join(dest, "tsconfig.json"));
copyFileSync(join(projectFiles, "gitignore"), join(dest, ".gitignore"));
writeFileSync(join(dest, "README.md"), readFileSync(join(projectFiles, "README.md"), "utf8").replaceAll("__NAME__", name));

const v = self.version;
const packs = process.env.CREATE_MARG_APP_PACKS;
const marg = (p) => (packs ? `file:${resolve(packs, `marg-${p}-${v}.tgz`)}` : `${v}`);
const pkg = {
  name,
  version: "0.1.0",
  private: true,
  type: "module",
  description: `${name} — a Marg agent (created by create-marg-app ${v})`,
  engines: { node: ">=22" },
  scripts: {
    gateway: "marg-gateway",
    "gateway:evals": "AGENT_ALLOW_WRITES=false AGENT_REQUIRE_LOGIN=false AGENT_RATE_DISABLED=true GATEWAY_PORT=8788 marg-gateway",
    evals: "tsx examples/support-intake/evals/run-evals.ts",
    "new-domain": "tsx scripts/new-domain.ts",
    typecheck: "tsc -p . --noEmit",
  },
  dependencies: {
    "@marg/core": marg("core"),
    "@marg/evals": marg("evals"),
    "@marg/gateway": marg("gateway"),
    "@marg/types": marg("types"),
    "@marg/verdict": marg("verdict"),
    "@modelcontextprotocol/sdk": "^1.12.0",
    zod: "^3.23.8",
  },
  devDependencies: {
    "@types/node": "^22.0.0",
    tsx: "^4.19.0",
    typescript: "^5.5.0",
  },
};
if (packs) {
  // Transitive @marg dependencies must come from the same tarballs, not the registry.
  pkg.overrides = { "@marg/types": marg("types"), "@marg/core": marg("core"), "@marg/verdict": marg("verdict"), "@marg/metering": marg("metering"), "@marg/widget": marg("widget") };
}
writeFileSync(join(dest, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

const rel = target === "." ? "." : target;
console.log(`created ${name} in ${dest}\n`);
console.log(`next:\n  cd ${rel}\n  npm install\n  npm run gateway            # the playground on http://localhost:8787 — type "ticket for Northwind: login fails on mobile"\n`);
console.log(`then:\n  npm run new-domain -- bookings     # your own domain from templates/\n  npm run gateway:evals & npm run evals   # the example's gate, writes off\n\n  .env holds LLM_CHAIN=mock (no key). Docs: https://github.com/marg-adk/marg#readme`);
