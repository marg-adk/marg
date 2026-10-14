/**
 * lib/cli.js — the marg commands. Plain ESM, no build; every command is a function of argv.
 *
 * The project root is the working directory: .env, domains/, examples/, templates/ (when
 * create-marg-app put them there) are read from it, and the gateway discovers domains under it.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
const require = createRequire(import.meta.url);

const HELP = `marg ${pkg.version} — the one command for a Marg project

  marg web [--port 8787] [--writes on|off]      the gateway and the playground (http://localhost:8787)
  marg new <name> [--entity noun] [--title "Title"] [--dir domains] [--lang ts|python]
                                               a domain scaffolded from the templates
  marg evals [suite.ts …] [--gateway URL] [--shard i/n]
                                               scenario suites against a writes-off gateway
  marg verdict "<text>" --choice k=a,b,c       a typed decision from the shell (see marg verdict --help)
  marg check                                   the gate: typecheck, then every suite, writes off
  marg --version | marg help

Settings are the environment (.env in the project): https://marg-adk.github.io/marg/run/environment
`;

/** argv → { _: positionals, flags } ; "--k v" and "--k=v" both work; a lone "--k" is true. */
function parse(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      if (v !== undefined) out.flags[k] = v;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) out.flags[k] = argv[++i];
      else out.flags[k] = true;
    } else out._.push(a);
  }
  return out;
}

/** Spawn with inherited stdio; resolves with the exit code. */
function sh(cmd, args, opts = {}) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: "inherit", ...opts });
    p.on("error", rej);
    p.on("exit", (code, signal) => res(code ?? (signal ? 1 : 0)));
  });
}

/** The file a package's export resolves to, or null. */
function packageDir(name) {
  try {
    return dirname(require.resolve(`${name}/package.json`));
  } catch {
    return null;
  }
}

// ---- marg web -------------------------------------------------------------------------
async function web(flags) {
  if (flags.port) process.env.GATEWAY_PORT = String(flags.port);
  if (flags.writes === "off") process.env.AGENT_ALLOW_WRITES = "false";
  if (flags.writes === "on") process.env.AGENT_ALLOW_WRITES = "true";
  const gw = packageDir("@marg-adk/gateway");
  if (!gw) throw new Error("@marg-adk/gateway is not installed — npm install @marg-adk/gateway");
  // domains are TypeScript (steps/index.ts, mock/policy.ts) imported at boot: the tsx loader first
  const { register } = await import("tsx/esm/api");
  register();
  await import(pathToFileURL(join(gw, "dist", "server.js")).href);
  return new Promise(() => {}); // the server owns the process from here; SIGTERM drains it
}

// ---- marg new -------------------------------------------------------------------------
function templatesDir() {
  const local = resolve("templates");
  if (existsSync(join(local, "domain.json.template"))) return local;
  const bundled = join(here, "..", "payload", "templates");
  if (existsSync(join(bundled, "domain.json.template"))) return bundled;
  throw new Error("no templates found: expected ./templates (create-marg-app puts them there) or the package's own copy");
}
function newDomain(positionals, flags) {
  const name = positionals[0];
  if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) {
    console.error('usage: marg new <kebab-name> [--title "Title"] [--entity noun] [--dir domains] [--lang ts|python]');
    return 2;
  }
  const title = flags.title ?? name.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
  const entity = String(flags.entity ?? name.split("-").pop() ?? "entry").toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const parent = String(flags.dir ?? "domains");
  const lang = String(flags.lang ?? "ts").toLowerCase();
  if (!["ts", "typescript", "python", "py"].includes(lang)) {
    console.error(`unknown --lang "${lang}": ts (default) or python`);
    return 2;
  }
  const python = lang === "python" || lang === "py";
  const dest = resolve(parent, name);
  if (existsSync(dest)) {
    console.error(`refusing: ${dest} already exists`);
    return 1;
  }
  const templates = templatesDir();
  // The manifest names the server the gateway spawns: `npx tsx …/server.ts` or `python3 …/server.py`.
  const serverFile = `${parent}/${name}/mcp/server.${python ? "py" : "ts"}`;
  const mcp = python ? { command: "python3", args: [serverFile] } : { command: "npx", args: ["tsx", serverFile] };
  const fill = (s) =>
    s.replaceAll("__NAME__", name).replaceAll("__TITLE__", title).replaceAll("__ENTITY__", entity).replaceAll("__MCP_COMMAND__", mcp.command).replaceAll('["__MCP_ARGS__"]', JSON.stringify(mcp.args));
  const map = {
    "domain.json.template": "domain.json",
    "SKILL.md.template": `skills/${name}/SKILL.md`,
    "schema-registry.template.json": `schema/${entity}-schema.json`,
    "steps.template.ts": "steps/index.ts",
    "eval-suite.template.ts": "evals/run-evals.ts",
    "mock-policy.template.ts": "mock/policy.ts",
    "probe.template.ts": "probe/probe.ts",
    ...(python ? { "mcp-server.template.py": "mcp/server.py", "requirements.template.txt": "mcp/requirements.txt" } : { "mcp-server.template.ts": "mcp/server.ts" }),
  };
  const written = [];
  for (const file of readdirSync(templates)) {
    const out = map[file];
    if (!out) continue;
    const target = join(dest, out);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, fill(readFileSync(join(templates, file), "utf8")));
    written.push(out);
  }
  mkdirSync(join(dest, "fixtures"), { recursive: true });
  writeFileSync(join(dest, "README.md"), fill("# __TITLE__\n\nScaffolded by `marg new`. Build order: tools → probe → schema → skill → steps → evals\n(https://marg-adk.github.io/marg/build/new-domain).\n"));
  written.push("README.md");
  console.log(`${name}: ${written.length} files under ${parent}/${name}/\n  ${written.join("\n  ")}`);
  console.log(`\nthe method, step by step: skills/build-a-domain/SKILL.md (a coding agent can follow it)`);
  console.log(`\nnext:\n  1. ${parent}/${name}/mcp/server.${python ? `py — pip install -r ${parent}/${name}/mcp/requirements.txt, then` : "ts —"} the tools (reads, validate / preview / create)\n  2. probe/probe.ts --yes against your dev backend; fold the findings into schema/${entity}-schema.json\n  3. skills/${name}/SKILL.md, then steps/index.ts\n  4. marg web  (discovered at boot) → walk it in the playground\n  5. marg check`);
  return 0;
}

// ---- marg evals -----------------------------------------------------------------------
function findSuites() {
  const suites = [];
  for (const root of ["domains", "examples"]) {
    if (!existsSync(root)) continue;
    for (const d of readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const f = join(root, d.name, "evals", "run-evals.ts");
      if (existsSync(f)) suites.push(f);
    }
  }
  return suites;
}
async function evals(positionals, flags) {
  const suites = positionals.length ? positionals : findSuites();
  if (!suites.length) {
    console.error("marg evals: no suites found (domains/*/evals/run-evals.ts, examples/*/evals/run-evals.ts)");
    return 2;
  }
  const env = { ...process.env };
  if (flags.gateway) env.EVAL_GATEWAY = String(flags.gateway);
  if (flags.shard) env.EVAL_SHARD = String(flags.shard);
  let worst = 0;
  for (const s of suites) {
    console.log(`\n▶ ${s}`);
    const code = await sh(process.execPath, ["--import", "tsx", s], { env });
    worst = Math.max(worst, code);
  }
  return worst;
}

// ---- marg verdict ---------------------------------------------------------------------
async function verdict(argv) {
  const v = packageDir("@marg-adk/verdict");
  if (!v) throw new Error("@marg-adk/verdict is not installed — npm install @marg-adk/verdict");
  return sh(process.execPath, [join(v, "dist", "cli.js"), ...argv]);
}

// ---- marg check -----------------------------------------------------------------------
/** A port nothing listens on (the OS picks it), so two gates never collide. */
function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}
async function answering(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

async function check(flags) {
  const port = flags.port ? Number(flags.port) : await freePort();
  if (await answering(`http://localhost:${port}/api/health`)) throw new Error(`something already answers on :${port} — the gate must run against its own gateway (pick another --port)`);
  if (existsSync("tsconfig.json")) {
    console.log("▶ typecheck");
    const tsc = packageDir("typescript");
    const code = tsc ? await sh(process.execPath, [join(tsc, "bin", "tsc"), "-p", ".", "--noEmit"]) : await sh("npx", ["tsc", "-p", ".", "--noEmit"]);
    if (code) return code;
  }
  const suites = findSuites();
  if (!suites.length) {
    console.log("no eval suites — nothing more to check");
    return 0;
  }
  console.log(`▶ gateway on :${port}, writes OFF`);
  const gw = spawn(process.execPath, [join(here, "..", "bin", "marg.js"), "web", "--port", String(port), "--writes", "off"], {
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, AGENT_REQUIRE_LOGIN: "false", AGENT_RATE_DISABLED: "true", AGENT_SESSION_DIR: ".data/sessions-check" },
  });
  try {
    const up = await waitFor(`http://localhost:${port}/api/health`, 60);
    if (!up) throw new Error(`the gateway did not answer on :${port} within 60s`);
    return await evals(suites, { gateway: `http://localhost:${port}` });
  } finally {
    gw.kill("SIGTERM");
  }
}
async function waitFor(url, seconds) {
  for (let i = 0; i < seconds * 2; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

export async function run(argv) {
  const { _: positionals, flags } = parse(argv);
  const cmd = positionals.shift();
  if (!cmd || cmd === "help" || flags.help) {
    console.log(HELP);
    return 0;
  }
  if (cmd === "--version" || flags.version) {
    console.log(pkg.version);
    return 0;
  }
  switch (cmd) {
    case "web":
      return web(flags);
    case "new":
      return newDomain(positionals, flags);
    case "evals":
      return evals(positionals, flags);
    case "verdict":
      return verdict(argv.slice(1));
    case "check":
      return check(flags);
    default:
      console.error(`marg: unknown command "${cmd}"\n`);
      console.log(HELP);
      return 2;
  }
}
