# LocalPilot

Zero-config, fully local AI coding assistant for VS Code — **Tab autocomplete**,
**Cmd+K inline editing**, **sidebar chat**, and **`@codebase` search**, all powered by
[Ollama](https://ollama.com) running on your own machine. Nothing you write ever
leaves your computer: every model call goes to `127.0.0.1`.

> **v1 scope:** macOS on Apple Silicon (M-series) only. Intel Macs, Windows, and
> Linux are out of scope for this release. See [`docs/`](./docs) for the full spec.

---

## What you get

| Feature                  | How to use it                                                                                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tab autocomplete**     | Pause while typing in a supported language; ghost text appears. **Tab** to accept, **Esc** to dismiss.                                                                     |
| **Cmd+K inline editing** | Select code, press **Cmd+K**, type an instruction. The rewrite streams in as a red/green diff. **Cmd+Enter** to accept, **Esc** to reject (restores the original exactly). |
| **Sidebar chat**         | Click the LocalPilot icon in the activity bar. Streaming answers, your current file as automatic context, markdown + syntax highlighting, **Stop** / **New Chat**.         |
| **`@codebase` search**   | Type `@codebase` in a chat message to ground the answer in your indexed project, with file/line citations.                                                                 |

A toggle in the chat header turns inline completions on/off live.

---

## Requirements

- **macOS on Apple Silicon.**
- **VS Code 1.85+.**
- **~5–30 GB free disk**, depending on your hardware tier — LocalPilot picks
  model sizes to match your RAM and downloads them on first run.
- **[Ollama](https://ollama.com)** — if it isn't installed, LocalPilot installs it
  for you via the official script on first activation and starts it automatically.

You do **not** need to configure anything, sign in, or get an API key. There is no
cloud account and no telemetry.

---

## Install & run

LocalPilot is not on the VS Code Marketplace yet (packaging is the final phase).
For now, run it from source:

```bash
git clone https://github.com/shobhitsinha04/localpilot.git
cd localpilot
npm install
npm run build      # bundle to dist/extension.js
```

Then open the folder in VS Code and press <kbd>F5</kbd> (**Run -> Run LocalPilot
Extension**). This launches an Extension Development Host window with LocalPilot
loaded.

### First run

On first activation LocalPilot will, automatically:

1. Detect your hardware tier (chip / RAM / free disk / macOS version) and pick the
   matching chat, autocomplete, and embedding models.
2. Ensure Ollama is installed and running (installing/starting it if needed).
3. Download the models it needs (this can take a few minutes the first time;
   progress is logged to the **LocalPilot** Output channel).
4. Index your open workspace so `@codebase` can answer questions about it.

Open the **LocalPilot** Output channel (**View -> Output -> LocalPilot**) to watch
setup progress and per-request timing.

---

## Using it

- **Autocomplete** — start typing and pause; accept with **Tab**. Rapid typing
  cancels stale suggestions. A status-bar spinner shows while one is generating.
- **Cmd+K editing** — select the code to change, press **Cmd+K**, and describe the
  edit ("add error handling", "convert to async", ...). Review the red/green diff,
  then **Cmd+Enter** to keep it or **Esc** to discard.
- **Chat** — open the sidebar and ask questions; your active file is sent as
  context automatically. Code blocks are syntax-highlighted with a copy button.
- **`@codebase`** — include `@codebase` in your question to search the whole
  indexed project, e.g. `@codebase where do we map RAM to a tier?`. Answers cite
  the files and line ranges they're drawn from.

### Commands (Cmd+Shift+P)

- **LocalPilot: Rebuild Index** — force a clean, full re-index of the workspace
  (use if `@codebase` results look stale or incomplete).
- **LocalPilot: Edit Selection** / **Accept Edit** / **Reject Edit** — the Cmd+K
  flow (also bound to Cmd+K / Cmd+Enter / Esc).

---

## Privacy

Everything runs locally through Ollama on `127.0.0.1:11434`. Your code, prompts,
and chat history never leave your machine, and there is no analytics or telemetry.
The only outbound network access is the one-time Ollama install script and model
downloads from the Ollama registry.

---

## Troubleshooting

- **Setup or model issues** — open the **LocalPilot** Output channel for detailed
  logs (hardware detection, install, model pulls, request timing).
- **`@codebase` answers look stale or wrong** — run **LocalPilot: Rebuild Index**.
- **First completion is slow** — the model is loading; it stays warm afterward.
- **Known issues, fixes, and their caveats** are catalogued phase by phase in
  [`docs/ISSUES_AND_FIXES.md`](./docs/ISSUES_AND_FIXES.md).

---

## Development

Requires Node.js 18+ and VS Code.

```bash
npm install        # install toolchain
npm run build      # bundle the extension with esbuild -> dist/extension.js
npm run watch      # rebuild on change
npm run lint       # ESLint
npm run format     # Prettier (write)
npm test           # Vitest unit tests
npm run typecheck  # tsc --noEmit (both the extension and webview configs)
```

Press <kbd>F5</kbd> to build and launch the Extension Development Host.

### Branching strategy

`main` (stable) <- `dev` (integration) <- feature branches. `dev` is merged into
`main` via GitHub Pull Requests. See `docs/PHASES.md`.

---

## Documentation

All product and architecture specs live in [`docs/`](./docs). Start with
[`docs/PROJECT.md`](./docs/PROJECT.md); see [`docs/CHANGELOG.md`](./docs/CHANGELOG.md)
for current state and [`docs/ISSUES_AND_FIXES.md`](./docs/ISSUES_AND_FIXES.md) for
the issue/fix history.
