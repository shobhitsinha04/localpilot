# CHANGELOG.md

This file is maintained by the Documenter Agent. Do not edit manually.
Each entry is added after a phase is approved by the Judge Agent.
Newest entries appear at the top.

Read this file at the start of every Builder Agent session to understand
the current state of the codebase before writing any new code.

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
