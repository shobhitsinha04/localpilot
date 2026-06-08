// ESLint flat config (ESLint 9) for LocalPilot.
//
// TECH_STACK.md: ESLint + Prettier enforce consistency across the two-person
// team. typescript-eslint provides the TypeScript parser and rules.
// eslint-config-prettier disables stylistic rules that would conflict with
// Prettier — Prettier owns formatting, ESLint owns correctness.

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "media/webview.js",
      "media/webview.js.map",
      "node_modules/**",
      "*.config.mjs",
      "esbuild.js",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      // The Judge rubric (AGENT_JUDGE.md, Dimension 5) flags `any` usage —
      // warn so it surfaces in review without blocking iteration.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      eqeqeq: ["error", "always"],
      "no-console": "off",
    },
  },
  // Must come last so it can disable conflicting stylistic rules.
  prettier,
);
