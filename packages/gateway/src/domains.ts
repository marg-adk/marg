/**
 * domains.ts — domain discovery for the gateway.
 *
 * A domain is a drop-in folder with a `domain.json` (the ONLY registration mechanism). The
 * gateway globs every folder under the domain roots — `domains/` and `examples/` by default,
 * or AGENT_DOMAIN_DIRS=dir1,dir2 — at boot, connects each domain's MCP server, loads its
 * runtime-owned steps, and declares the capabilities the prompt tells users about. A broken
 * manifest logs a warning and is skipped, never crashes boot. AGENT_DOMAINS=a,b limits which
 * discovered domains are installed.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { DomainManifest } from "@marg-adk/types";
import { pathToFileURL } from "node:url";
import { REPO_ROOT, connectDomainMcp, envList, llmChain, loadDomainSteps, log, registerCapabilities } from "@marg-adk/core";

let cache: DomainManifest[] | null = null;

function roots(): string[] {
  const dirs = envList("AGENT_DOMAIN_DIRS");
  return (dirs.length ? dirs : ["domains", "examples"]).map((d) => (isAbsolute(d) ? d : join(REPO_ROOT, d)));
}

export function discoverDomains(): DomainManifest[] {
  if (cache) return cache;
  const only = new Set(envList("AGENT_DOMAINS"));
  const found: DomainManifest[] = [];
  for (const root of roots()) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, entry.name);
      const manifestPath = join(dir, "domain.json");
      if (!existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as DomainManifest;
        if (!manifest.name || !manifest.mcp?.command) throw new Error("name and mcp.command are required");
        if (only.size && !only.has(manifest.name)) continue;
        if (found.some((d) => d.name === manifest.name)) {
          log.warn("duplicate domain name — later folder skipped", { name: manifest.name, dir });
          continue;
        }
        found.push({ ...manifest, dir });
      } catch (e) {
        log.warn("skipping domain — bad domain.json", { dir, error: (e as Error).message });
      }
    }
  }
  cache = found;
  return found;
}

/** Connect every installed domain's MCP server, load its steps, declare capabilities. */
export async function installDomains(): Promise<DomainManifest[]> {
  const domains = discoverDomains();
  for (const d of domains) {
    try {
      await connectDomainMcp(d.name, d.mcp.command, d.mcp.args);
    } catch (e) {
      log.error("domain MCP failed to connect — the domain is installed without tools", { domain: d.name, error: (e as Error).message });
    }
    try {
      await loadDomainSteps(d);
    } catch (e) {
      log.error("domain steps failed to load", { domain: d.name, error: (e as Error).message });
    }
    if (d.mock && llmChain().some((ep) => ep.kind === "mock")) {
      try {
        await import(pathToFileURL(isAbsolute(d.mock) ? d.mock : join(d.dir, d.mock)).href);
        log.info("mock model registered", { domain: d.name, module: d.mock });
      } catch (e) {
        log.error("mock model failed to load", { domain: d.name, error: (e as Error).message });
      }
    }
  }
  registerCapabilities(domains.map((d) => ({ name: d.name, title: d.title, description: d.description })));
  return domains;
}
