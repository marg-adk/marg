/**
 * website/sync.mjs — mirror the repository's documentation into website/src for VitePress.
 *
 * WHAT COMES IN: the markdown under docs/, the root documents (ROADMAP, CHANGELOG, CONTRIBUTING,
 *   …), deploy/DEPLOY.md, the example's README, and the authored pages in website/pages.
 * WHAT COMES OUT: website/src (git-ignored): every source at its site path (the MAP below),
 *   with links rewritten — a link to a mapped file becomes a site link, a link to anything else
 *   in the repository becomes its GitHub URL — plus a "Source: …" footer. Authored pages copy
 *   over last and win.
 * WHO TALKS TO IT: npm run site:build / site:dev (via site:sync), the pages workflow.
 *
 * The docs stay where they are and keep working on GitHub; the site is a view of them.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const out = join(here, "src");
const GITHUB = "https://github.com/marg-adk/marg/blob/main/";

/** repository path → site path (without .md) */
const MAP = {
  "docs/PATTERN.md": "build/pattern",
  "docs/PLAYBOOK.md": "build/playbook",
  "docs/DOMAIN-WORKSHEET.md": "build/worksheet",
  "docs/guides/new-domain.md": "build/new-domain",
  "docs/guides/new-step.md": "build/new-step",
  "docs/guides/readers.md": "build/readers",
  "docs/guides/evals.md": "build/evals",
  "examples/support-intake/README.md": "build/example",
  "skills/build-a-domain/SKILL.md": "build/coding-agent",
  "examples/bookings/README.md": "build/example-bookings",
  "docs/ARCHITECTURE.md": "components/architecture",
  "docs/CLIENT-PROTOCOL.md": "components/client-protocol",
  "docs/DECISIONS.md": "components/decisions",
  "docs/METERING.md": "components/metering",
  "docs/SECURITY.md": "components/security",
  "docs/SDK-AUTH.md": "components/sdk-auth",
  "docs/ENVIRONMENT.md": "run/environment",
  "docs/OBSERVABILITY.md": "run/observability",
  "docs/PRODUCTION-CHECKLIST.md": "run/production-checklist",
  "deploy/DEPLOY.md": "run/deploy",
  "docs/LESSONS.md": "reference/lessons",
  "ROADMAP.md": "reference/roadmap",
  "CHANGELOG.md": "reference/changelog",
  "RELEASING.md": "reference/releasing",
  "CONTRIBUTING.md": "community/contributing",
  "CODE_OF_CONDUCT.md": "community/code-of-conduct",
  "SECURITY.md": "community/security-policy",
};
for (const f of readdirSync(join(repo, "docs/adr"))) if (f.endsWith(".md")) MAP[`docs/adr/${f}`] = `reference/adr/${f.replace(/\.md$/, "").toLowerCase()}`;
for (const dir of ["posts", "reviews"]) {
  const d = join(repo, "docs", dir);
  if (!existsSync(d)) continue;
  for (const f of readdirSync(d)) if (f.endsWith(".md")) MAP[`docs/${dir}/${f}`] = `community/${dir}/${f.replace(/\.md$/, "")}`;
}

/** Rewrite one markdown link target found in `srcPath` (repo-relative). */
function rewrite(target, srcPath) {
  if (/^(https?:|mailto:|#)/.test(target)) return target;
  const [path, hash = ""] = target.split("#");
  const resolved = posix.normalize(posix.join(posix.dirname(srcPath), path));
  if (MAP[resolved]) return `/${MAP[resolved]}${hash ? "#" + hash : ""}`;
  if (resolved === "README.md") return "/";
  if (resolved === "docs/README.md") return "/build/pattern";
  if (resolved.startsWith("docs/images/")) return `/${resolved.replace(/^docs\//, "")}`;
  return GITHUB + resolved + (hash ? "#" + hash : "");
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
let n = 0;
for (const [src, dest] of Object.entries(MAP)) {
  let md = readFileSync(join(repo, src), "utf8");
  // Markdown links and images: [text](target) — code spans are left alone by the lookbehind on backticks being rare in targets.
  md = md.replace(/(!?\[[^\]]*\]\()([^)\s]+)(\))/g, (m, a, t, b) => a + rewrite(t, src) + b);
  // Vue would interpret {{ }} and bare <tags>; escape the few that appear outside code fences.
  md = escapeOutsideCode(md);
  md += `\n\n---\n\n<small>Source: <a href="${GITHUB}${src}">${src}</a> — edit it there; the site mirrors the repository.</small>\n`;
  const file = join(out, dest + ".md");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, md);
  n++;
}
mkdirSync(join(out, "images"), { recursive: true });
cpSync(join(repo, "docs/images"), join(out, "images"), { recursive: true });
cpSync(join(here, "pages"), out, { recursive: true });
console.log(`site:sync — ${n} documents mirrored, authored pages applied`);

function escapeOutsideCode(md) {
  // Real HTML the docs use on purpose stays; every other "<" is text (placeholders like <name>).
  const HTML = /^<\/?(br|hr|img|p|a|small|details|summary|sup|sub|b|i|em|strong|code|pre|table|thead|tbody|tr|td|th|ul|ol|li|h[1-6]|div|span|kbd)(\s|>|\/)/i;
  const parts = md.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  return parts
    .map((p, i) => (i % 2 === 1 ? p : p.replace(/\{\{/g, "&#123;&#123;").replace(/<(?=[^<]*)/g, (m, off, str) => (HTML.test(str.slice(off, off + 12)) ? m : "&lt;"))))
    .join("");
}
