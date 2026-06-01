# LocalPilot

Zero-config, fully local AI coding assistant for VS Code. Tab autocomplete,
CMD+K inline editing, sidebar chat, and `@codebase` search — all powered by
[Ollama](https://ollama.com) running on your own machine. Nothing you write
ever leaves your computer.

> **v1 scope:** macOS on Apple Silicon only. See `docs/` for the full spec.

## Status

Early development. Phase 0 (project setup) is complete: the extension scaffolds,
bundles, lints, and runs a hello-world command. Features land phase by phase per
`docs/PHASES.md`.

## Development

Requires Node.js 18+ and VS Code.

```bash
npm install        # install toolchain
npm run build      # bundle the extension with esbuild -> dist/extension.js
npm run watch      # rebuild on change
npm run lint       # ESLint
npm run format     # Prettier (write)
npm test           # Vitest unit tests
npm run typecheck  # tsc --noEmit
```

### Run the extension

Press <kbd>F5</kbd> in VS Code (or pick **Run LocalPilot Extension** in the Run
panel). This builds the extension and launches an Extension Development Host
window where you should see a **"Hello World from LocalPilot!"** notification.

## Branching strategy

`main` (stable) ← `dev` (integration) ← feature branches. See
`docs/PHASES.md`.

## Documentation

All product and architecture specs live in [`docs/`](./docs). Start with
`docs/PROJECT.md`.
