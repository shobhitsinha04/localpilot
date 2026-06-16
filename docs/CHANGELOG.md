# CHANGELOG.md

This file is maintained by the Documenter Agent. Do not edit manually.
Each entry is added after a phase is approved by the Judge Agent.
Newest entries appear at the top.

Read this file at the start of every Builder Agent session to understand
the current state of the codebase before writing any new code.

---

## Phase 5 — CMD+K Inline Editing
**Status:** Approved by Judge Agent
**Judge Score:** 27/30 (see JUDGE_SCORES.md)

### What Was Built

Select code → **⌘K** → type an instruction → the selection is rewritten by the
model and shown as a red/green diff → **⌘↩ Accept** / **Esc Reject**
(FEATURES.md, DATA_FLOW.md §2, UI_UX.md). Uses the chat model (already pulled);
not a webview feature — it manipulates the editor directly.

`PromptEngine.buildEditPrompt(instruction, selection, prefix, suffix, filename,
language)` (src/services/promptEngine.ts): assembles the rewrite prompt body —
filename/language, the 10 lines of context above and below, the delimited
selection, and the instruction (empty context blocks omitted). Pairs with the
`EDIT_SYSTEM_PROMPT` constant ("Rewrite the selected code… return only the
rewritten code"). `editOptions()` returns the DATA_FLOW §2 sampling (temperature
0.2, top_p 0.95). Pure and `vscode`-free.

`diffLines(original, updated)` (src/services/lineDiff.ts): a pure LCS line diff
producing `context` / `removed` / `added` rows, used to render the red/green
view. Display-only — the exact original text is kept verbatim for a clean Reject.

`cleanEditOutput(raw)` (src/services/editPostprocess.ts): strips the ```lang …
``` fences small instruct models add despite the system prompt. Safe on a
partial buffer, so it runs on every streamed token for a clean live preview.

`OllamaService.generateStream()` (src/services/ollamaService.ts): streaming
`POST /api/generate`, instruct-templated (NOT `raw`, unlike Phase 4's
`complete()` — the model must follow the rewrite instruction), with the system
prompt in the `system` field and an `AbortSignal` for Esc/Reject.

`CmdKController` (src/cmdkController.ts): the editor-coupled session machine.
Captures the selection, prompts via `showInputBox`, streams the rewrite into the
document live (coalesced edits), then swaps the preview for a red/green diff
block (theme-coloured whole-line decorations) with an Accept/Reject CodeLens. A
context key `localpilot.cmdkActive` scopes the ⌘↩ / Esc keybindings. Teardown is
race-safe: on Esc the session is detached synchronously and in-flight renders
are drained before the original is restored, so a mid-stream cancel leaves the
file exactly as it was. `[cmd+k]` timing/state logs go to the Output channel. The
controller is a `Disposable` (decorations + CodeLens emitter disposed).

134 Vitest tests (up from 113) — `buildEditPrompt`/`editOptions`, the line diff,
and the fence cleaner.

### Implementation Decisions

- **Input box = `showInputBox`** (DECISIONS 014): a decoration cannot host an
  editable input, so the spec's floating box isn't buildable in stable APIs.
- **Diff = theme decorations + CodeLens** (DECISIONS 015): no floating button
  bar (can't float an interactive widget) and no `−`/`+` gutter glyphs (gutter
  icons can't follow the theme without hardcoding colours, which UI_UX forbids).
- **`generateStream` is templated, not `raw`** — the instruct model must apply
  its chat template to follow the instruction.
- **Race-safe Esc** — the session is detached before aborting so the streaming
  loop and live renders bail and can't repaint over the restore.

### Judge Findings Addressed

Approved 27/30, no Critical findings. Both Minor findings fixed before close:
(1) the two stable-API UI deviations now have DECISIONS entries (014, 015);
(2) the omitted `−`/`+` gutter glyphs are recorded in DECISIONS 015 (theme-safe
gutter glyphs aren't achievable without hardcoding colours). A Judge observation
— a silently failed final restore edit — now logs a warning. Privacy was
verified directly by the Judge (every `fetch` targets `127.0.0.1:11434`).

### Known Issues

Tracked as Linear issues (Linear is external to this repo — log there):
- The CMD+K UI is an approximation of UI_UX.md (native input box, CodeLens
  action bar, no ±gutter glyphs) bounded by stable VS Code APIs — see DECISIONS
  014/015.
- The controller's editor-coupled session logic is verified by manual F5, not
  Vitest (the pure logic it drives — diff, prompt, cleanup — is unit-tested).

No critical issues.

### Current State

Selecting code and pressing ⌘K opens an instruction box; submitting streams the
rewrite in place, then shows a red/green diff with an Accept/Reject CodeLens.
⌘↩ keeps it, Esc restores the original exactly (including mid-stream). Not yet
built: `@codebase` retrieval + the onboarding UI (Phase 6), and packaging
(Phase 7).

---

## Phase 4 — Inline Completions
**Status:** Approved by Judge Agent
**Judge Score:** 28/30 (see JUDGE_SCORES.md)

### What Was Built

Tab-autocomplete: ghost-text completions appear when you pause typing, accepted
with Tab and dismissed with Esc (FEATURES.md, DATA_FLOW.md §1). Powered by the
Qwen2.5-Coder Fill-in-the-Middle (FIM) model over Ollama. Not a webview feature —
it uses VS Code's inline completion API.

`PromptEngine.buildFIMPrompt(prefix, suffix)` (src/services/promptEngine.ts):
assembles the FIM prompt with Qwen's `<|fim_prefix|>…<|fim_suffix|>…<|fim_middle|>`
tokens. `completionOptions()` returns the DATA_FLOW §1 sampling (temperature 0.1,
top_p 0.95, stop `["\n\n"]`). Pure and `vscode`-free.

`cleanCompletion(raw, suffix)` (src/services/completionPostprocess.ts): defensive
cleanup of small-model output — strips any echoed special tokens, unwraps stray
markdown fences, and trims a tail that merely repeats the start of the suffix
(so accepting a suggestion can't duplicate a bracket/line already after the
cursor). Pure, returns "" when nothing usable remains.

`OllamaService.complete()` (src/services/ollamaService.ts): now sends `raw: true`
(so Ollama doesn't wrap the FIM tokens in the instruct chat template), accepts an
`AbortSignal` + per-request timeout (abort/timeout resolve to "" rather than
throwing), and an optional `keep_alive` to keep the model resident between
requests.

`CompletionProvider` (src/completionProvider.ts): the `InlineCompletionItemProvider`.
600ms debounce that honours VS Code's `CancellationToken` (a newer keystroke
supersedes the pending request); a single `AbortController` drives both
supersession and the timeout; extracts 20 lines of prefix / 10 of suffix around
the cursor → FIM prompt → `complete()` → post-process → `InlineCompletionItem`.
Best-effort: any failure yields no suggestion, never a user-facing error.
Per-request timing prints to the Output channel (`[completion] served in N ms`),
and a status-bar spinner shows while a completion is generating.

`extension.ts` registers the provider for a curated code-language allowlist
(`COMPLETION_LANGUAGES`), ensures the configured autocomplete model is pulled
(tier 3/4 use a model the earlier steps don't fetch), and pre-warms it so the
first real completion isn't a cold load. A single `ConfigManager` is now shared
across the chat panel, smoke test, and completion provider.

**Autocomplete toggle:** a labelled on/off switch in the chat header (next to New
Chat) flips inline completions live and persists via `inlineCompletionsEnabled`
in config.json; the provider reads it on each request. **Chat typing indicator:**
a three-dot animation now shows in the assistant bubble while awaiting the first
token (replacing the bare cursor).

113 Vitest tests (up from 96) cover FIM assembly, completion post-processing,
the config default/back-fill, and the new protocol message.

### Implementation Decisions

- **Plain FIM, no filename** (`buildFIMPrompt(prefix, suffix)`): a live harness
  showed a leading `<|file_sep|>` filename made the model emit stray markdown
  fences; plain FIM is cleanest. PHASES.md's `(…, filename, language)` signature
  was updated to match.
- **`raw: true` is required** on `/api/generate`: without it Ollama applies the
  instruct chat template and the model replies with prose instead of completing.
- **Timeout 5s, not DATA_FLOW §1's 3s** (DECISIONS 013): a cold model load is
  ~2.7s and a 3s budget aborted it silently; 5s covers cold loads while the warm
  path (~0.3s) stays under the 2s DoD.
- **`keep_alive` (30m) + activation pre-warm**: additions beyond §1 that target
  the dominant cold-load latency, found via live timing.
- **Shared `ConfigManager`**: so the chat-panel toggle reaches the provider
  without a reload (previously chat and the provider held separate instances).

### Judge Findings Addressed

Approved 28/30, no Critical findings. Both Minor findings fixed before close:
(1) the completion timeout was a 10s debug value vs §1's 3s → set to 5s and the
deviation recorded as DECISIONS 013, with DATA_FLOW §1 annotated; (2) the
`buildFIMPrompt` signature dropped the `filename`/`language` params PHASES.md
listed → PHASES.md updated to the live-validated plain-FIM signature. Privacy was
verified directly by the Judge (every `fetch` targets `127.0.0.1:11434`).

### Known Issues

Tracked as Linear issues (Linear is external to this repo — log there):
- Provider-level logic (debounce, supersession, timing, status-bar ref-count) is
  `vscode`-coupled and not unit-tested — verified by manual F5 per the DoD.
- The completion timeout (5s) is a hardware-informed default; revisit with
  real-world latency once more machines are tested.

No critical issues.

### Current State

Pausing while typing in a supported language shows a ghost-text suggestion (Tab
to accept, Esc to dismiss); rapid typing debounces and supersedes cleanly, and a
status-bar spinner signals generation. The chat panel gained an Autocomplete
on/off switch and a typing indicator. Not yet built: CMD+K editing (Phase 5) and
`@codebase` + the onboarding UI (Phase 6).

---

## Phase 3 — Sidebar Chat
**Status:** Approved by Judge Agent
**Judge Score:** 27/30 (see JUDGE_SCORES.md)

### What Was Built

A working chat panel in the VS Code primary sidebar (FEATURES.md §3, UI_UX.md,
DATA_FLOW.md §3). Streaming responses, the current file as automatic context,
multi-turn session memory, Stop / New Chat, markdown + syntax highlighting, and
inline error states. `@codebase` retrieval and the onboarding UI remain deferred
to Phase 6.

`ConversationManager` (src/services/conversationManager.ts): in-memory
user/assistant transcript for the session — `addUser`/`addAssistant`,
`getHistory` (defensive copy), `clear`. Not persisted to disk.

`PromptEngine` (src/services/promptEngine.ts): `buildChatPrompt(userMessage,
history, fileContext?)` assembles the Ollama message array — system prompt with
the current file silently injected, the trimmed history, then the user message.
Trims to the most recent `MAX_HISTORY_MESSAGES` (20 ≈ 10 exchanges). `chatOptions()`
returns the DATA_FLOW §3 sampling options (temperature 0.7, top_p 0.95). Pure
and `vscode`-free.

`webviewProtocol.ts`: the typed postMessage contract between the webview and the
extension host (`WebviewMessage` / `HostMessage` discriminated unions) plus
`parseWebviewMessage`, a validating parser that rejects malformed input.

`ChatViewProvider` (src/chatViewProvider.ts): the `WebviewViewProvider`. Gathers
active-editor context (filename, language, contents if ≤500 lines, cursor +
selection), assembles the prompt, streams `OllamaService.chat()` tokens to the
webview, supports Stop via `AbortController`, and maps failures to FEATURES §3's
inline error states (not running → Restart; model not ready → Retry; timeout;
empty). Builds the webview HTML with a CSP and per-load nonce. Tracks the last
active editor so file context survives the chat input being focused.

Webview (src/webview/main.ts → bundled to media/webview.js; media/webview.css;
media/icon.svg): plain HTML/CSS/vanilla JS (DECISIONS 009). Renders markdown
with marked (raw HTML neutralised) and highlights code with highlight.js; live
streaming cursor, per-code-block language label + copy button, clickable
empty-state prompts, and inline (non-toast) error rows. All colours come from VS
Code theme variables except the accent and the syntax-token palette. Bundled via
a second esbuild entry (browser/IIFE).

`OllamaService.chat()` gained an optional `AbortSignal` (Stop) and a
time-to-first-token timeout (so a long-streaming reply isn't cut off mid-stream).
`extension.ts` registers the provider with `retainContextWhenHidden` and forwards
active-editor changes. 96 Vitest tests (ConversationManager, PromptEngine, the
protocol parser).

### Implementation Decisions

- **Webview HTML is generated in the provider** (with the CSP nonce injected),
  not a separate template file — simplest nonce handling.
- **XSS defenses:** a CSP with `script-src 'nonce-…'` plus marked configured to
  escape raw HTML; model output is rendered as markdown only.
- **Separate `tsconfig.webview.json`** (lib DOM, `types: []`) so the browser
  webview type-checks without colliding with `@types/node`'s fetch types; the
  main config excludes `src/webview`.
- **Timeout is time-to-first-token, not total** request time (a streaming chat
  reply can legitimately run long); the surfaced message matches FEATURES §3.
- **Syntax-token colours are hardcoded** in webview.css (documented) because VS
  Code does not expose per-token editor theme colours to webviews.

### Judge Findings Addressed

Approved 27/30, no Critical findings. Two Minor findings fixed before close:
(1) an immediate Stop (before any token) posted a spurious "No response received"
error — it now ends quietly and the empty bubble is dropped; (2) "model not
loaded" is now a distinct inline error with a working Retry action (a pre-send
`hasModel()` check). The third Minor finding — token/context-window trimming
(only message-count trimming exists today) — is deferred to Phase 6, when
`@codebase` introduces the larger contexts that need it.

### Known Issues

Tracked as Linear issues (Linear is external to this repo — log there):
- Token-based context-window trimming and file-content truncation are not yet
  implemented (PromptEngine trims by message count only). Add before Phase 6.
- A failed send (e.g. Ollama not running) shows the user bubble in the UI but
  does not record it in `ConversationManager` history — a minor UI/state
  divergence on the error path.

No critical issues.

### Current State

Opening the LocalPilot sidebar shows a chat panel that streams model responses
with the current file as automatic context, renders markdown with syntax-
highlighted, copyable code blocks, supports Stop and New Chat, retains history
across activity-bar switches, and surfaces failures inline. The webview is
manual-tested (per TECH_STACK.md). Not yet built: inline completions (Phase 4),
CMD+K editing (Phase 5), and `@codebase` + the onboarding UI (Phase 6).

---

## Phase 2 — Codebase Indexing
**Status:** Approved by Judge Agent
**Judge Score:** 28/30 (see JUDGE_SCORES.md)

### What Was Built

`Chunker` (src/services/chunker.ts): pure `chunk(content, filename)` splits a
file into overlapping 150-line windows with 20-line overlap (DATA_FLOW.md §5),
tagging each with filename + 1-based startLine/endLine. Drops a file-final
trailing-newline line so counts match the editor; drops whitespace-only chunks.

`FileWalker` (src/services/fileWalker.ts): `walk(workspacePath)` returns absolute
paths of indexable files, skipping node_modules/.git/dist/build/__pycache__,
`.gitignore` matches (via the `ignore` package), binary files (extension list +
null-byte sniff), and files >500KB. Pure predicates (`shouldSkipDir`,
`hasBinaryExtension`, `looksBinary`, `isTooLarge`) are unit-tested.

`IndexManager` (src/services/indexManager.ts): the per-workspace LanceDB index at
`globalStorageUri/index/<workspaceHash>/` (sha256 of the workspace path, per
DECISIONS 005). `indexWorkspace()` walks → chunks → embeds (nomic-embed-text via
OllamaService) → stores, processing files in batches of 5. `search()` embeds the
query, runs a cosine vector search (top 20), and reranks. `updateFile()` /
`deleteFile()` handle incremental changes; `isIndexed()` reports state. Writes
are guarded by `proper-lockfile`. Pure, unit-tested scoring is exported:
`rerank` (0.7×similarity + 0.3×recency → top 8, DATA_FLOW.md §4),
`computeSimilarity`, `computeRecency`.

`extension.ts`: the activation smoke test now continues into Phase 2 —
`runIndexingSmokeTest` pulls the embedding model, indexes the open workspace
(logging progress), records `{ indexed, fileCount, workspaceHash }` in
`config.workspaceIndexes`, runs a sample query and logs the top chunks, then
`registerIndexWatcher` wires a `vscode.workspace.createFileSystemWatcher` to
`updateFile`/`deleteFile` (registered once per session; lives in extension.ts so
IndexManager stays `vscode`-free). New shared types (CodeChunk, RetrievedChunk,
IndexProgress, IndexStats) and constants (chunk geometry, batch size, top-K,
rerank weights, skip lists). 81 Vitest tests (25 new) cover chunk boundaries,
walker skip rules, and the rerank/similarity/recency math.

### Implementation Decisions

- **Cosine, not L2, similarity.** nomic embeddings are not normalised, so raw L2
  distances are large and collapse `1/(1+d)` similarity toward ~0.002, letting
  recency dominate ranking entirely (caught via a live indexing harness).
  `search()` sets `.distanceType("cosine")` and `computeSimilarity` =
  `clamp(1 − distance, 0, 1)`, giving meaningful ~0.5–0.63 scores and relevant
  ranking. (DATA_FLOW §3/§4 text implied L2; this is a deliberate, documented
  deviation.)
- **`EMBED_MAX_CHARS = 4000`.** nomic-embed-text has a ~2048-token context; a
  dense 150-line chunk can exceed it and return HTTP 500, silently dropping the
  chunk. The embedding *input* is truncated to 4000 chars (empirically safe;
  ~4500 is the breaking point) while the **full** chunk text is still stored for
  Phase 6 prompt assembly. Chunk geometry (line ranges) is unchanged.
- **Recency** is undefined in DATA_FLOW; implemented as exponential decay with a
  30-day half-life (`RECENCY_HALF_LIFE_MS`), isolated as a constant.
- **Files in batches of 5** (DATA_FLOW §5): a batch of 5 files is embedded
  concurrently, chunks within a file sequentially, and inserts are serialised
  (LanceDB table create/add must not race).
- **Absolute paths** are the canonical chunk key (reliable delete/update; the
  watcher provides fsPaths); display is relativised via
  `vscode.workspace.asRelativePath`.
- `@lancedb/lancedb` is marked **external** in esbuild — it ships a native
  `.node` binary that can't be bundled; its `require()` resolves at runtime.

### Judge Findings Addressed

Both Minor findings from the Judge review were fixed before this entry (not
deferred): (1) `updateFile`/`deleteFile` acquired the lock before the index dir
existed (`proper-lockfile` `realpath:true` → ENOENT), so a watcher event before
the first full index silently no-opped — `acquireLock()` now ensures the dir;
(2) `isIndexablePath` used a raw `startsWith` prefix check (`/project` matched
`/project-2`) — replaced with a `path.relative` containment check.

### Known Issues

Tracked as Linear issues (Linear is external to this repo — log there):
- `OllamaService.hasModel()`/`listModelNames()` match names with exact
  `includes()`. An untagged model like `nomic-embed-text` is stored by Ollama as
  `nomic-embed-text:latest`, so `hasModel("nomic-embed-text")` returns false even
  when present. The Phase 2 path is unaffected (pull succeeds on exit code 0;
  `embed()` passes the untagged name, which Ollama resolves to `:latest` for
  inference), but a presence check used in Phase 6 onboarding would misfire.
  Compounds the Phase 1 observation about digest-qualified names — consider
  tag-tolerant matching.
- Incremental `updateFile` does not re-check `.gitignore` (a documented
  simplification): a save to a gitignored *text* file that the initial walk
  skipped could be indexed on update.

No critical issues.

### Current State

On activation the extension runs the Phase 1 chain, then indexes the open
workspace into a per-workspace LanceDB store, logs the top chunks for a sample
query, and watches for file changes to keep the index current. Semantic search
returns relevant chunks (verified on this repo: 44 files → 99 chunks, with the
hardware-tier docs and detector ranking top for a tier query). Not yet built:
the sidebar chat webview (Phase 3), inline completions (Phase 4), CMD+K editing
(Phase 5), and @codebase wiring + the onboarding UI (Phase 6). The
`IndexManager.search()`/`rerank()` surface is ready for Phase 6 @codebase.

---

## Phase 1 — Ollama Integration + Hardware Detection
**Status:** Approved by Judge Agent
**Judge Score:** 27/30

### What Was Built

`HardwareDetector` (src/services/hardwareDetector.ts): `detect()` reads RAM via
`sysctl hw.memsize`, chip via `sysctl machdep.cpu.brand_string`, macOS version
via `sw_vers -productVersion`, and free disk via `fs.statfs(homedir())`. Never
throws — Intel Macs return an unsupported profile; any failure defaults to
Tier 2. Pure exported helpers (all unit-tested): `mapMemoryToTier`,
`applyDiskFallback`, `parseChip`, `parseIsAppleSilicon`, `parseMacosMajor`,
`modelsForTier`.

`OllamaService` (src/services/ollamaService.ts): `isInstalled()` (known paths +
PATH scan), `isRunning()` (GET /api/tags), `install()` (official script via
/bin/sh), `start()` (spawns `ollama serve` detached, polls), `pullModel()`
(CLI `ollama pull`, parses progress, presence-check + retry), `chat()`
(POST /api/chat, streamed async generator of tokens), `complete()`
(POST /api/generate), `embed()` (POST /api/embeddings), `hasModel()` /
`listModelNames()`, and `stop()`. Pure exported parsers (unit-tested):
`parsePullProgressLine`, `parseStreamLine`, `summariseStderr`. Base URL is
configurable.

`ConfigManager` (src/services/configManager.ts): `load`/`save`/`update`/`get`
for config.json in globalStorageUri. Schema: `{ onboardingComplete, tier,
chatModel, autocompleteModel, embeddingModel, workspaceIndexes }`. Missing or
corrupt files fall back to defaults without throwing.

`extension.ts`: wraps a VS Code Output Channel as the service `Logger`; on
activation (activationEvents: `onStartupFinished`) runs a developer smoke test —
detect hardware → record tier + model names in config → ensure Ollama
installed/running → pull the chat model (with progress logging) → send
"say hello" → log the streamed response. Commands `localpilot.helloWorld` and
`localpilot.runSmokeTest`; a `smokeTestInFlight` guard prevents concurrent runs;
`deactivate()` stops the serve process. Shared `types.ts` and `constants.ts`
hold all named constants (tier thresholds, TIER_MODELS, disk floors, timeouts).

Services take an injected `Logger` and (for ConfigManager) a storage path, so
none import `vscode` — only extension.ts does. This keeps all service logic
unit-testable. 56 Vitest tests cover tier boundaries, parsers, and config I/O.

### Implementation Decisions

- `OLLAMA_DEFAULT_BASE_URL = http://127.0.0.1:11434` (not "localhost"): Node's
  fetch can resolve "localhost" to ::1 first, causing ECONNREFUSED against
  Ollama (which listens on 127.0.0.1). Still localhost — privacy unchanged.
- `pullModel` treats **model presence** (`hasModel` via /api/tags) as the
  success signal, not the CLI exit code. `ollama pull` can exit non-zero on a
  transient network error ("context deadline exceeded") even though the server
  retries and the model completes. Retries up to `OLLAMA_PULL_MAX_ATTEMPTS = 3`;
  stderr is captured and condensed via `summariseStderr` for diagnostics.
  (Found and fixed during F5 verification.)
- Disk-aware tier fallback is generalized: `TIER_REQUIRED_DISK_GB` defines a
  per-tier free-disk floor (Tier 4 = 30GB from HARDWARE_PROFILES.md), and
  `applyDiskFallback` steps down one tier at a time until the floor is met.
- The smoke test pulls only the **chat** model. Autocomplete and embedding
  model *names* are recorded in config, but their downloads are deferred to
  Phase 2 (indexing) / Phase 6 (onboarding).
- `findBinary()` scans PATH as a fallback so a non-standard Homebrew prefix
  doesn't cause a false "not installed" after a successful install.

SPEC DEVIATION: The Helicone observability proxy is removed from the v1 path
(DECISIONS 011). OllamaService calls Ollama directly via the configurable base
URL; a proxy can be reinserted later with no call-site changes. ARCHITECTURE.md,
TECH_STACK.md, DATA_FLOW.md, and PHASES.md were updated to match.

SPEC DEVIATION: `pullModel` uses the CLI `ollama pull` + stdout parsing (per
PHASES.md / ONBOARDING_FLOW.md), NOT `POST /api/pull` (which TECH_STACK.md lists
as an available endpoint). The CLI path required the presence-check/retry
robustness above. Switching to `POST /api/pull` (cleaner streamed JSON progress)
remains an option post-Phase-1 if spurious CLI failures recur.

SPEC DEVIATION: 36GB RAM maps to **Tier 3**, not Tier 4. HARDWARE_PROFILES.md
was internally ambiguous at 36GB (summary table lists it in both Tier 3 and
Tier 4); resolved and formalized in DECISIONS 012.

### Known Issues

Tracked as Linear issues (Linear is external to this repo — log there):
- `hasModel()` matches model names from /api/tags with exact `includes()`. If a
  future Ollama version returns digest-qualified names
  (e.g. `qwen2.5-coder:7b@sha256:...`), the check would miss and trigger an
  unnecessary re-pull. None observed in current versions. (Judge observation #7.)
- `smokeTestInFlight` is module-level state. Correct for the single
  extension-host process in v1; would reset if the host ever hot-reloads
  modules. (Judge observation #4.)

No critical issues. All three minor Judge findings (parseStreamLine and
ConfigManager.save test gaps, and the DECISIONS 012 comment cross-reference)
were fixed before this entry.

### Current State

The extension activates on startup, detects the hardware tier (chip / unified
memory / free disk / macOS version), selects and persists the tier's chat,
autocomplete, and embedding model names, ensures Ollama is installed (installing
via the official script if absent) and running (starting `ollama serve` if
needed), pulls the chat model with progress and transient-failure resilience,
sends a test prompt, and logs the streamed reply to the LocalPilot Output
Channel. `OllamaService.complete()`, `embed()`, and `chat()` are implemented and
ready for later phases. There is no observability proxy (Helicone deferred) and
no user-facing UI beyond the Output Channel and notifications. Not yet built:
codebase indexing + LanceDB (Phase 2), the sidebar chat webview (Phase 3),
inline completions (Phase 4), CMD+K editing (Phase 5), and @codebase + the
onboarding UI (Phase 6).

---
