# TECH_STACK.md

## Overview

This file documents every technology, library, and tool used in LocalPilot,
and the reasoning behind each choice. Claude Code should not introduce any
dependency not listed here without a documented reason added to this file
and a corresponding entry in DECISIONS.md.

---

## Language

### TypeScript
**Version:** 5.x
**Why:** VS Code extensions must be written in JavaScript or TypeScript.
TypeScript is the standard choice — it gives type safety which matters
enormously when building something with many interacting services.
The VS Code API itself is fully typed via @types/vscode.

**Compilation target:** ES2022, CommonJS modules (required by VS Code
extension host).

---

## Runtime & Build

### Node.js
**Version:** 18.x LTS minimum
**Why:** Required by the VS Code extension host. No choice here.

### esbuild
**Why:** Bundles the extension TypeScript into a single output file for
distribution. Significantly faster than webpack and simpler to configure.
Continue.dev uses the same approach.

### ESLint + Prettier
**Why:** Code consistency across two developers. Configured once, enforced
automatically. Non-negotiable on a multi-person project.

---

## VS Code Extension APIs

### @types/vscode
**Why:** Type definitions for the entire VS Code API. Required for any
VS Code extension.

**Key APIs used:**
- `vscode.languages.registerInlineCompletionItemProvider` — tab autocomplete
- `vscode.window.registerWebviewViewProvider` — sidebar chat panel
- `vscode.commands.registerCommand` — CMD+K and command palette entries
- `vscode.workspace.createFileSystemWatcher` — watching for file changes
- `vscode.window.createTextEditorDecoration` — diff highlighting for CMD+K
- `vscode.ExtensionContext.globalStorageUri` — where we store index + config

### vscode-webview-ui-toolkit (optional, evaluate during build)
**Why:** Microsoft's official UI components for VS Code webviews. Gives
buttons, inputs, and panels that match VS Code's native look automatically.
Evaluate during implementation — if it adds unnecessary complexity, use
plain HTML/CSS instead.

---

## Local LLM Inference

### Ollama
**Version:** Latest stable
**Why:** The only mature, production-ready tool for running LLMs locally
on macOS with Metal GPU acceleration. Has a clean REST API, handles model
management, supports streaming, and works out of the box on Apple Silicon.
No meaningful alternative exists for this use case.

**API endpoints used:**
- `GET /api/tags` — check if Ollama is running, list downloaded models
- `POST /api/generate` — completions (inline autocomplete, CMD+K)
- `POST /api/chat` — chat with message history (sidebar chat)
- `POST /api/embeddings` — generate embeddings for indexing + retrieval
- `POST /api/pull` — download a model

**Models used:**
See HARDWARE_PROFILES.md for full model selection logic.
- `qwen2.5-coder:1.5b` — Tier 1 chat + autocomplete
- `qwen2.5-coder:3b` — Tier 3/4 autocomplete
- `qwen2.5-coder:7b` — Tier 2 chat
- `qwen2.5-coder:14b` — Tier 3 chat
- `qwen2.5-coder:32b` — Tier 4 chat
- `nomic-embed-text` — embeddings for all tiers

---

## Vector Database

### LanceDB (Node.js SDK)
**Package:** `@lancedb/lancedb`
**Why:**
- Embedded — no separate process, no Docker, no server to manage
- Stores data on disk, persists between sessions
- Fast vector similarity search
- TypeScript SDK is first-class and well maintained
- Used by Continue.dev for the exact same purpose — proven in this context
- Apache 2.0 license

**Alternative considered:** ChromaDB — rejected because it requires a
separate Python server process, which adds significant complexity to
installation and maintenance.

**Alternative considered:** SQLite with sqlite-vss — rejected because
the vector search extension is experimental and setup is fragile on macOS.

---

## Observability

### Helicone (Local Proxy)
**Why:** Sits between our Ollama Service and Ollama itself. Logs every
LLM call locally — prompt, response, latency, token count. Invaluable
for debugging why a completion is slow or why a response is wrong.

**Important:** In v1, only the local proxy is used. No data is sent to
Helicone's cloud. The proxy runs as a local process started by the
extension on activation.

**How it runs:** Helicone's local proxy is started as a child process
by the extension on activation and stopped when VS Code closes.

**Post-v1:** Offer users an opt-in to Helicone cloud for a proper
dashboard with latency graphs, error rates, and prompt history. Off
by default — privacy first.

---

## Project Management

### Linear
**Why:** Issue tracking for a two-person team. Every feature from
PHASES.md becomes a Linear issue. Every bug the Judge Agent catches
becomes a Linear issue. Keeps work visible and organised without
overhead.

**How it's used:**
- One project per phase (Phase 1, Phase 2, etc.)
- Issues created from PHASES.md before each phase starts
- Bug reports from Judge Agent reviews logged as issues immediately
- Weekly sync between team members to review open issues

Linear is a development tool only — it has no integration with the
extension itself.

---

## Testing

### Vitest
**Why:** Fast, TypeScript-native test runner. Works well with the
Node.js environment of a VS Code extension. Simpler setup than Jest
for TypeScript projects.

**What gets tested:**
- Prompt Engine — unit tests for prompt assembly logic
- Hardware Detector — unit tests for tier mapping logic
- Context Service — unit tests for chunking and retrieval logic
- Ollama Service — integration tests against a running Ollama instance

**What does not get tested in v1:**
- Webview UI (too complex to automate, covered by manual testing)
- End-to-end extension behaviour (covered by manual testing)

### VS Code Extension Test Runner
**Why:** Microsoft's official test harness for running tests inside
a real VS Code instance. Used for integration tests that require
the actual VS Code API (file system watching, editor decorations, etc.)

---

## Webview UI

### Plain HTML + CSS + Vanilla JavaScript
**Why:** The sidebar chat panel is a VS Code webview. Webviews run in
a sandboxed iframe — importing React or other frameworks adds bundle
size and complexity for what is ultimately a chat interface with a
text input and a message list.

Plain HTML/CSS/JS is sufficient, easier to debug, and loads faster.
If complexity grows significantly post-v1, React can be introduced then.

**Styling approach:** CSS custom properties mapped to VS Code's theme
variables (--vscode-editor-background, --vscode-foreground, etc.) so
the panel automatically matches the user's VS Code theme — light or dark.

### Marked.js
**Package:** `marked`
**Why:** Markdown rendering in the webview for model responses. Lightweight,
fast, no dependencies. Code blocks are post-processed with highlight.js
for syntax highlighting.

### highlight.js
**Package:** `highlight.js`
**Why:** Syntax highlighting inside code blocks in the chat panel.
Loaded in the webview only. Supports all languages we care about.

---

## Utilities

### node-fetch (or native fetch)
**Why:** HTTP calls to the Ollama API from the extension host.
Node 18+ includes native fetch — use that. No additional dependency needed.

### ignore
**Package:** `ignore`
**Why:** Parses .gitignore files during codebase indexing so we skip
the same files git skips. Lightweight, well-maintained, does one thing.

### proper-lockfile
**Package:** `proper-lockfile`
**Why:** Prevents two instances of VS Code from writing to the LanceDB
index simultaneously if the user has multiple windows open.

---

## What We Are Deliberately Not Using

| Technology | Reason Not Used |
|------------|-----------------|
| React / Vue in webview | Overkill for a chat UI, adds bundle complexity |
| Python anywhere | Extension must be pure TypeScript/Node.js |
| LangChain / LlamaIndex | Too much abstraction, hides what's happening, hard to debug |
| Electron | We are a VS Code extension, not a standalone app |
| Any cloud SDK | Nothing goes to the cloud in v1 |
| Webpack | esbuild is faster and simpler for this use case |
| ChromaDB | Requires a separate server process |
| OpenAI SDK | We talk to Ollama directly via HTTP, no SDK needed |
