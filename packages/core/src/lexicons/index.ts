/**
 * lexicons/index.ts — opt-in registers for the readers. The core vocabulary is English; a
 * register adds words, rewrite rules and question markers for one process (the gateway, an MCP
 * server that reads replies, a test). `AGENT_LEXICONS=hinglish` (comma-separated) at boot, or
 * `loadLexicons(["hinglish"])` in code; an unknown name is a boot error, not a silent gap.
 */
import { extendLexicon, type LexiconExtension } from "../reply-words.js";
import { hinglish } from "./hinglish.js";

const REGISTRY: Record<string, LexiconExtension> = { hinglish };
const loaded = new Set<string>();

export const availableLexicons = (): string[] => Object.keys(REGISTRY);

export function loadLexicons(names: string[]): string[] {
  const out: string[] = [];
  for (const raw of names) {
    const name = raw.trim().toLowerCase();
    if (!name || loaded.has(name)) continue;
    const lex = REGISTRY[name];
    if (!lex) throw new Error(`unknown lexicon "${name}" (available: ${availableLexicons().join(", ")})`);
    extendLexicon(lex);
    loaded.add(name);
    out.push(name);
  }
  return out;
}

/** AGENT_LEXICONS=hinglish,… → the registers loaded (none when unset). */
export function loadLexiconsFromEnv(): string[] {
  return loadLexicons((process.env.AGENT_LEXICONS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
}

export const loadedLexicons = (): string[] => [...loaded];
