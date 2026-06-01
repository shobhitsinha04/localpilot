// esbuild bundler for the LocalPilot VS Code extension.
//
// Bundles src/extension.ts into a single CommonJS file at dist/extension.js,
// which is what the VS Code extension host loads (see package.json "main").
// The `vscode` module is provided by the extension host at runtime and must
// never be bundled, so it is marked external.
//
// TECH_STACK.md: esbuild is used instead of webpack — faster, simpler config,
// same approach as Continue.dev.

const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  // VS Code extension host requires CommonJS targeting Node 18 LTS (TECH_STACK.md).
  target: "node18",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log("[esbuild] watching for changes...");
  } else {
    await esbuild.build(buildOptions);
    console.log("[esbuild] build complete -> dist/extension.js");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
