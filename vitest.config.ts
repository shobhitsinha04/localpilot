import { defineConfig } from "vitest/config";

// TECH_STACK.md: Vitest is the unit-test runner. It runs the pure-logic tests
// (Prompt Engine, Hardware Detector tier mapping, Chunker, IndexManager
// search/rerank). Anything that needs the real `vscode` API runs under the
// VS Code Extension Test Runner instead, not here.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    globals: true,
  },
});
