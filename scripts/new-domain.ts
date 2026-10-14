/**
 * scripts/new-domain.ts — scaffold a domain from templates/.
 *
 *   npm run new-domain -- <name> [--title "Human title"] [--entity noun] [--dir domains] [--lang ts|python]
 *
 * WHAT COMES IN: a kebab-case name; optional display title, entity noun (singular), parent dir and the
 *   language of the tool server (TypeScript by default; `--lang python` for the official Python SDK).
 * WHAT COMES OUT: <dir>/<name>/{domain.json, skills/<name>/SKILL.md, schema/<entity>-schema.json,
 *   steps/index.ts, evals/run-evals.ts, mock/policy.ts, probe/probe.ts, mcp/server.ts (or mcp/server.py +
 *   mcp/requirements.txt), README.md} with __NAME__ / __TITLE__ / __ENTITY__ replaced and the manifest
 *   pointing at the server. Refuses to overwrite an existing folder.
 * WHO TALKS TO IT: a developer, once per domain. The gateway discovers the result at boot
 *   (AGENT_DOMAIN_DIRS, default "domains,examples").
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const name = args.find((a, i) => !a.startsWith("--") && (i === 0 || !args[i - 1].startsWith("--")));
const flag = (k: string): string | undefined => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) {
  console.error('usage: npm run new-domain -- <kebab-name> [--title "Title"] [--entity noun] [--dir domains] [--lang ts|python]');
  process.exit(2);
}
const title = flag("title") ?? name.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
const entity = (flag("entity") ?? name.split("-").pop() ?? "entry").toLowerCase().replace(/[^a-z0-9_]/g, "_");
const parent = flag("dir") ?? "domains";
const lang = (flag("lang") ?? "ts").toLowerCase();
if (!["ts", "typescript", "python", "py"].includes(lang)) {
  console.error(`unknown --lang "${lang}": ts (default) or python`);
  process.exit(2);
}
const python = lang === "python" || lang === "py";
const dest = join(root, parent, name);
if (existsSync(dest)) {
  console.error(`refusing: ${dest} already exists`);
  process.exit(1);
}

// The manifest names the server the gateway spawns: `npx tsx …/server.ts` or `python3 …/server.py`.
const serverFile = `${parent}/${name}/mcp/server.${python ? "py" : "ts"}`;
const mcp = python ? { command: "python3", args: [serverFile] } : { command: "npx", args: ["tsx", serverFile] };
const fill = (s: string): string =>
  s.replaceAll("__NAME__", name).replaceAll("__TITLE__", title).replaceAll("__ENTITY__", entity).replaceAll("__MCP_COMMAND__", mcp.command).replaceAll('["__MCP_ARGS__"]', JSON.stringify(mcp.args));
const map: Record<string, string> = {
  "domain.json.template": "domain.json",
  "SKILL.md.template": `skills/${name}/SKILL.md`,
  "schema-registry.template.json": `schema/${entity}-schema.json`,
  "steps.template.ts": "steps/index.ts",
  "eval-suite.template.ts": "evals/run-evals.ts",
  "mock-policy.template.ts": "mock/policy.ts",
  "probe.template.ts": "probe/probe.ts",
  ...(python ? { "mcp-server.template.py": "mcp/server.py", "requirements.template.txt": "mcp/requirements.txt" } : { "mcp-server.template.ts": "mcp/server.ts" }),
};
const templates = join(root, "templates");
const written: string[] = [];
for (const file of readdirSync(templates)) {
  const out = map[file];
  if (!out) continue;
  const target = join(dest, out);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, fill(readFileSync(join(templates, file), "utf8")));
  written.push(out);
}
mkdirSync(join(dest, "fixtures"), { recursive: true });
writeFileSync(
  join(dest, "README.md"),
  fill("# __TITLE__\n\nScaffolded from `templates/`. Build order (docs/guides/new-domain.md): tools → probe → schema → skill → steps → evals.\n"),
);
written.push("README.md");
console.log(`${name}: ${written.length} files under ${parent}/${name}/\n  ${written.join("\n  ")}`);
console.log(
  `\nnext:\n  1. mcp/server.${python ? "py — pip install -r ${parent}/${name}/mcp/requirements.txt, then" : "ts —"} the tools (reads, validate / preview / create)\n  2. probe/probe.ts --yes against your dev backend; fold the findings into schema/${entity}-schema.json\n` +
    `  3. skills/${name}/SKILL.md, then steps/index.ts\n  4. npm run gateway  (discovered at boot) → walk it in the playground\n  5. npm run gateway:evals & npx tsx ${parent}/${name}/evals/run-evals.ts`,
);
