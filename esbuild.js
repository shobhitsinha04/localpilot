// esbuild bundler for the LocalPilot VS Code extension.
//
// Bundles src/extension.ts into a single CommonJS file at dist/extension.js,
// which is what the VS Code extension host loads (see package.json "main").
// The `vscode` module is provided by the extension host at runtime and must
// never be bundled, so it is marked external.
//
// `@lancedb/lancedb` is a native module (ships a platform-specific .node binary
// that esbuild cannot inline), so it is also external — its require() is left to
// resolve from node_modules at runtime. NOTE (Phase 7 packaging): the LanceDB
// package and its platform binary must be kept in the published .vsix
// (i.e. not excluded by .vscodeignore).
//
// TECH_STACK.md: esbuild is used instead of webpack — faster, simpler config,
// same approach as Continue.dev.

const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** The extension host bundle (Node/CommonJS). */
/** @type {import('esbuild').BuildOptions} */
const extensionOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode", "@lancedb/lancedb"],
  format: "cjs",
  platform: "node",
  // VS Code extension host requires CommonJS targeting Node 18 LTS (TECH_STACK.md).
  target: "node18",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

/**
 * The sidebar chat webview bundle (browser/IIFE). Runs inside the sandboxed
 * webview iframe, so it targets the browser and bundles marked + highlight.js
 * in (DECISIONS 009: plain JS in the webview, no framework).
 */
/** @type {import('esbuild').BuildOptions} */
const webviewOptions = {
  entryPoints: ["src/webview/main.ts"],
  bundle: true,
  outfile: "media/webview.js",
  format: "iife",
  platform: "browser",
  target: "es2020",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

async function main() {
  if (watch) {
    const ctxExt = await esbuild.context(extensionOptions);
    const ctxWeb = await esbuild.context(webviewOptions);
    await Promise.all([ctxExt.watch(), ctxWeb.watch()]);
    console.log("[esbuild] watching for changes...");
  } else {
    await Promise.all([
      esbuild.build(extensionOptions),
      esbuild.build(webviewOptions),
    ]);
    console.log(
      "[esbuild] build complete -> dist/extension.js, media/webview.js",
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
