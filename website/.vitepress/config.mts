// VitePress configuration for marg-adk.github.io/marg. The content under website/src is
// mirrored from the repository by website/sync.mjs; the authored pages live in website/pages.
import { readFileSync } from "node:fs";
import { defineConfig } from "vitepress";

/** Written by website/sync.mjs: one entry per page under docs/providers and docs/integrations. */
const generated: { providers: { text: string; link: string }[]; integrations: { text: string; link: string }[] } = (() => {
  try {
    return JSON.parse(readFileSync(new URL("./generated-sidebar.json", import.meta.url), "utf8"));
  } catch {
    return { providers: [], integrations: [] };
  }
})();

const adr = ["0001-domains-and-routing", "0002-durable-stores", "0003-observability", "0004-runtime-owned-steps", "0005-typed-decisions", "0006-metering-pass-through"];

export default defineConfig({
  title: "Marg",
  description: "The Agent Development Kit for conversational agents that finish a job: runtime-owned steps, typed decisions, evals as the ratchet, a production spine. TypeScript, MCP, any model.",
  base: "/marg/",
  srcDir: "src",
  outDir: ".vitepress/dist",
  cleanUrls: true,
  ignoreDeadLinks: [/^https?:\/\/localhost/],
  lastUpdated: false,
  head: [
    ["meta", { name: "theme-color", content: "#111d33" }],
    ["meta", { property: "og:title", content: "Marg — agents that finish the job" }],
    ["meta", { property: "og:description", content: "An open-source Agent Development Kit for conversational agents that complete a transaction: the runtime owns the moments that must be right." }],
    ["meta", { property: "og:image", content: "https://marg-adk.github.io/marg/images/playground.gif" }],
  ],
  themeConfig: {
    siteTitle: "Marg",
    nav: [
      { text: "Get started", link: "/get-started/" },
      { text: "Build", link: "/build/pattern" },
      { text: "Components", link: "/components/architecture" },
      { text: "Run", link: "/run/environment" },
      { text: "Models", link: "/providers/" },
      { text: "Integrations", link: "/integrations/" },
      { text: "Reference", link: "/reference/roadmap" },
      { text: "Community", link: "/community/contributing" },
      { text: "Playground", link: "https://marg-playground.onrender.com" },
    ],
    sidebar: {
      "/get-started/": [
        { text: "Get started", items: [
          { text: "Quickstart", link: "/get-started/" },
          { text: "The playground", link: "/get-started/playground" },
          { text: "Your first domain", link: "/build/new-domain" },
          { text: "Build with a coding agent", link: "/build/coding-agent" },
          { text: "Marg and other frameworks", link: "/get-started/compare" },
        ] },
      ],
      "/build/": [
        { text: "Build", items: [
          { text: "The pattern", link: "/build/pattern" },
          { text: "The playbook", link: "/build/playbook" },
          { text: "The domain worksheet", link: "/build/worksheet" },
          { text: "The example domain", link: "/build/example" },
          { text: "Build with a coding agent", link: "/build/coding-agent" },
          { text: "The bookings example", link: "/build/example-bookings" },
        ] },
        { text: "Guides", items: [
          { text: "A new domain", link: "/build/new-domain" },
          { text: "A new step", link: "/build/new-step" },
          { text: "Readers", link: "/build/readers" },
          { text: "Evals", link: "/build/evals" },
        ] },
      ],
      "/components/": [
        { text: "Components", items: [
          { text: "Architecture", link: "/components/architecture" },
          { text: "The client protocol", link: "/components/client-protocol" },
          { text: "Decisions (Verdict)", link: "/components/decisions" },
          { text: "Metering", link: "/components/metering" },
          { text: "Security", link: "/components/security" },
          { text: "SDK auth", link: "/components/sdk-auth" },
        ] },
      ],
      "/run/": [
        { text: "Run", items: [
          { text: "Environment", link: "/run/environment" },
          { text: "Observability", link: "/run/observability" },
          { text: "Production checklist", link: "/run/production-checklist" },
          { text: "Deploy", link: "/run/deploy" },
        ] },
      ],
      "/providers/": [
        { text: "Models", items: [{ text: "Overview", link: "/providers/" }, ...generated.providers] },
      ],
      "/integrations/": [
        { text: "Integrations", items: [{ text: "Overview", link: "/integrations/" }, ...generated.integrations] },
      ],
      "/reference/": [
        { text: "Reference", items: [
          { text: "Roadmap", link: "/reference/roadmap" },
          { text: "Changelog", link: "/reference/changelog" },
          { text: "Releasing", link: "/reference/releasing" },
          { text: "Lessons from the field", link: "/reference/lessons" },
        ] },
        { text: "Decision records", items: [
          ...adr.map((a) => ({ text: a.replace(/^(\d+)-/, "ADR $1: ").replace(/-/g, " "), link: `/reference/adr/${a}` })),
          { text: "The ADR template", link: "/reference/adr/template" },
        ] },
      ],
      "/community/": [
        { text: "Community", items: [
          { text: "Contributing", link: "/community/contributing" },
          { text: "Code of conduct", link: "/community/code-of-conduct" },
          { text: "Security policy", link: "/community/security-policy" },
          { text: "Discussions", link: "https://github.com/marg-adk/marg/discussions" },
        ] },
        { text: "Writing", items: [
          { text: "The model must never read yes", link: "/community/posts/the-model-must-never-read-yes" },
          { text: "Review: adk.dev", link: "/community/reviews/adk-dev-2026-10" },
        ] },
      ],
    },
    socialLinks: [{ icon: "github", link: "https://github.com/marg-adk/marg" }],
    search: { provider: "local" },
    editLink: { pattern: "https://github.com/marg-adk/marg/tree/main", text: "The docs live in the repository" },
    footer: { message: "Apache-2.0. The docs are mirrored from the repository on every merge.", copyright: "Marg" },
    outline: { level: [2, 3] },
  },
  markdown: { lineNumbers: false },
});
