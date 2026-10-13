#!/usr/bin/env node
/**
 * marg — the one command for a Marg project.
 *
 *   marg web [--port 8787]            the gateway and the playground
 *   marg new <name> [--entity noun] [--title "Title"] [--dir domains]   a domain from the templates
 *   marg evals [suite.ts …] [--gateway http://…] [--shard i/n]          scenario suites against a writes-off gateway
 *   marg verdict "<text>" --choice …  a typed decision from the shell (the Verdict CLI)
 *   marg check                        the project's gate: typecheck, then every suite with writes off
 *
 * WHAT COMES IN: the working directory is the project (where .env, domains/, examples/ live).
 * WHAT COMES OUT: processes started, files written, an exit code that is the gate.
 * WHO TALKS TO IT: a developer in a project made by create-marg-app; package.json scripts.
 */
import { run } from "../lib/cli.js";

run(process.argv.slice(2)).then(
  (code) => process.exit(code ?? 0),
  (e) => {
    console.error(`marg: ${e && e.message ? e.message : e}`);
    process.exit(1);
  },
);
