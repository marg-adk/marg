// eslint.config.js — the lint gate (npm run lint). Correctness rules only: ESLint recommended plus
// typescript-eslint recommended; style is left to the file headers and reviewers. The widget is a
// browser script, the bin files and the log worker run under Node; everything else is TypeScript.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "packages/create-marg-app/payload/**", "**/results/**", "templates/**", "domains/**", ".data/**", "website/src/**", "website/.vitepress/cache/**", "website/.vitepress/dist/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
    },
  },
  { files: ["**/*.js", "**/*.mjs"], languageOptions: { globals: globals.node } },
  // The widget and its fake DOM are written in classic browser-script style (`const self = this`).
  { files: ["packages/widget/widget.js", "packages/widget/test/fake-dom.ts"], languageOptions: { globals: globals.browser }, rules: { "@typescript-eslint/no-this-alias": "off" } },
);
