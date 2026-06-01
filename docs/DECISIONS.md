# DECISIONS.md

## Overview

This is a living document. Every significant technical or product decision
gets logged here with the reasoning behind it. Claude Code must read this
file before making any architectural decision — if the decision is already
logged here, follow it. If something needs to deviate from a logged
decision, add a new entry explaining why.

Both developers must agree before a new decision is logged. No unilateral
architecture changes.

---

## Format

Each entry follows this structure:

**Decision:** What was decided
**Date:** When it was decided
**Why:** The reasoning
**Alternatives considered:** What else was evaluated and why it was rejected
**Consequences:** What this decision affects or constrains

---

## Logged Decisions

---

### 001 — Target macOS only for v1

**Decision:** v1 supports macOS on Apple Silicon only. Intel Macs, Windows,
and Linux are explicitly out of scope for v1.

**Why:** Apple Silicon's unified memory architecture makes local LLM
inference significantly more practical than any other consumer platform.
A 16GB MacBook Air can run a 7B model well. Targeting one platform lets
us build and test one hardware detection path, one Ollama install flow,
and one set of system commands. Scope control.

**Alternatives considered:**
- All platforms from day one — rejected because hardware detection,
  Ollama installation scripting, and GPU detection differ significantly
  across platforms. Too much surface area for a two-person team at this stage.

**Consequences:**
- Intel Mac users see an "unsupported" message during onboarding
- All system calls in HardwareDetector use macOS-specific commands
  (sysctl, sw_vers, statvfs)
- Windows/Linux support is the first post-v1 platform expansion

---

### 002 — VS Code extension, not a standalone app

**Decision:** LocalPilot is a VS Code extension, not a standalone Electron
app or IDE fork.

**Why:** Building a full IDE means building a text editor, file tree,
terminal, git integration, language servers — none of which is the actual
product. A VS Code extension lets us focus entirely on the AI layer.
Distribution is also simpler: install from the marketplace, no DMG or
installer required.

**Alternatives considered:**
- Standalone Electron app — rejected due to scope. Years of work for
  two developers before the AI features could even be built.
- Fork of VS Code like Cursor — rejected for the same reason. Cursor
  has a large funded team maintaining that fork.

**Consequences:**
- All UI is constrained to VS Code's webview system
- We inherit VS Code's UX patterns and limitations
- Distribution is via .vsix file and eventually the VS Code marketplace

---

### 003 — Ollama for local model serving

**Decision:** Ollama is the only supported inference backend in v1.

**Why:** Ollama is the only mature, production-ready tool for running
LLMs locally on macOS with Metal GPU acceleration. It has a clean REST
API, handles model management, supports streaming, and is well maintained.
No meaningful alternative exists for this use case on macOS.

**Alternatives considered:**
- llama.cpp directly — rejected because Ollama wraps llama.cpp and adds
  model management, a REST API, and Metal optimisation on top. Using
  llama.cpp directly would mean rebuilding what Ollama already does.
- LM Studio — rejected because it has no programmatic API suitable for
  extension integration.

**Consequences:**
- Users must have Ollama installed (we install it for them)
- All model management goes through Ollama's CLI and API
- Model files live in ~/.ollama/models/ which we do not control directly

---

### 004 — Qwen2.5-Coder across all tiers

**Decision:** Qwen2.5-Coder is the model family used at all hardware tiers
(1.5b, 3b, 7b, 14b, 32b).

**Why:** Available in every size needed, best-in-class for coding tasks
at every parameter count, Apache 2.0 license, strong Ollama support with
optimised macOS Metal builds, and consistent behaviour across the family.
The 32B model is competitive with GPT-4o on coding benchmarks.

**Alternatives considered:**
- DeepSeek Coder — strong benchmark performance but inconsistent model
  sizes for our tier requirements.
- CodeLlama — older, outperformed by Qwen2.5-Coder on most benchmarks.
- Mixing models across tiers — rejected to keep behaviour predictable
  and reduce testing surface area.

**Consequences:**
- All prompt engineering is tuned for Qwen2.5-Coder's instruction format
- FIM (Fill-in-the-Middle) format used for autocomplete is
  Qwen2.5-Coder's native format
- If Qwen2.5-Coder is deprecated or superseded, all tiers need updating

---

### 005 — LanceDB for vector storage

**Decision:** LanceDB is used for codebase indexing and retrieval.

**Why:** Embedded (no separate process), stores on disk, fast vector
similarity search, TypeScript SDK is first-class, Apache 2.0 license,
and proven in this exact use case by Continue.dev.

**Alternatives considered:**
- ChromaDB — rejected because it requires a separate Python server process,
  adding significant installation complexity.
- SQLite with sqlite-vss — rejected because the vector extension is
  experimental and setup is fragile on macOS.
- In-memory only — rejected because the index would need to be rebuilt
  every time VS Code opens, which is too slow for large codebases.

**Consequences:**
- Index files stored in globalStorageUri/index/
- One LanceDB index per workspace (keyed by workspace path hash)
- proper-lockfile needed to prevent concurrent writes from multiple
  VS Code windows

---

### 006 — nomic-embed-text for embeddings

**Decision:** nomic-embed-text via Ollama is used to generate embeddings
for codebase indexing and query retrieval.

**Why:** Small (~300MB), fast, runs via Ollama so no additional
infrastructure needed, good quality embeddings for code, and well
supported. Pulling it via Ollama keeps all model management in one place.

**Alternatives considered:**
- Generating embeddings via the chat model — rejected because embedding
  is a different task than generation and using the large chat model for
  embeddings would be slow and wasteful.
- OpenAI embeddings API — rejected because it sends code to an external
  server, violating the core privacy promise.

**Consequences:**
- nomic-embed-text is pulled during onboarding as a third model download
  (~300MB added to onboarding download size)
- All embeddings are float[] vectors from Ollama's /api/embeddings endpoint

---

### 007 — No LangChain or LlamaIndex

**Decision:** No LLM orchestration frameworks. All prompt assembly,
retrieval, and streaming logic is written directly in TypeScript.

**Why:** We have exactly one LLM provider (Ollama) that never changes.
LangChain and LlamaIndex exist to abstract over multiple providers and
add flexibility we don't need. They add abstraction layers that make
debugging harder and hide exactly the logic we need to understand and
control.

**Alternatives considered:**
- LangChain.js — rejected. Adds ~50MB of dependencies for zero benefit
  given our single-provider setup. Debugging prompt issues through
  LangChain's abstractions is significantly harder.
- LlamaIndex.TS — rejected for the same reasons.

**Consequences:**
- Prompt Engine, Context Service, and Ollama Service are all written
  from scratch in TypeScript
- More code to write upfront, but easier to debug and maintain
- No dependency on third-party framework release cycles

---

### 008 — Helicone local proxy for observability

**Status:** AMENDED by decision 011 — the Helicone layer is deferred to
post-v1. The reasoning below stands as the original rationale, but the
implementation is not part of v1. See 011 for the current position.

**Decision:** Helicone's local proxy sits between the extension and Ollama
for all LLM calls in development. No data is sent to Helicone's cloud in v1.

**Why:** Without observability, debugging LLM calls (slow responses, bad
prompts, unexpected outputs) is extremely difficult. Helicone's local proxy
gives us request logging, latency tracking, and token counts without any
data leaving the machine.

**Alternatives considered:**
- Manual console logging — rejected because it's too verbose and
  unstructured to be useful for debugging LLM calls specifically.
- Helicone cloud from day one — rejected because it sends prompt data
  externally, violating the privacy promise even during development.

**Consequences:**
- Helicone local proxy starts as a child process on extension activation
- All OllamaService HTTP calls route through the proxy port
- Post-v1: offer users opt-in to Helicone cloud for dashboards

---

### 009 — Plain HTML/CSS/JS for webview UI

**Decision:** The sidebar chat panel webview is built with plain
HTML, CSS, and vanilla JavaScript. No React, Vue, or other framework.

**Why:** The webview is a sandboxed iframe. The UI is a chat interface
with a text input and a message list — not complex enough to justify
a framework. Plain HTML/CSS/JS loads faster, is easier to debug, and
produces a smaller bundle.

**Alternatives considered:**
- React — rejected for v1. The component complexity doesn't justify the
  build setup and bundle size overhead in a webview context.
- Svelte — rejected for the same reasons.

**Consequences:**
- Markdown rendering via marked.js, syntax highlighting via highlight.js
- If UI complexity grows significantly post-v1, React can be introduced
- All theme compatibility via VS Code CSS custom properties

---

### 010 — 8GB RAM is the minimum supported tier

**Decision:** LocalPilot supports machines with 8GB unified memory.
The experience on 8GB is limited but functional, and this is communicated
honestly to users during onboarding.

**Why:** 8GB Macs are common, particularly older MacBook Airs. Excluding
them reduces the potential user base meaningfully. The 1.5B model runs
adequately on 8GB and provides real value even if quality is lower than
larger tiers.

**Alternatives considered:**
- Set floor at 16GB — rejected because it excludes a meaningful segment
  of Mac users for whom LocalPilot would still be useful.

**Consequences:**
- Tier 1 uses qwen2.5-coder:1.5b for both chat and autocomplete
- Onboarding shows an honest limitation notice on 8GB machines
- Performance testing must include a Tier 1 machine

---

### 011 — Defer the Helicone observability layer to post-v1

**Decision:** The Helicone local proxy is deferred. In v1 the OllamaService
communicates directly with Ollama at `localhost:11434` through a configurable
base URL. No observability proxy runs in v1. This amends decision 008.

**Date:** 2026-06-01

**Why:** Helicone ships no lightweight, spawnable local proxy. Its
self-hosted form is a full Docker Compose stack (Postgres, ClickHouse, MinIO,
a web dashboard, a Workers-based proxy run via wrangler) — a production
observability platform, not a sidecar. It cannot be started as a single child
process on activation the way ARCHITECTURE.md assumed, and requiring Docker on
every machine contradicts the zero-config promise and the goal of shipping to
beta users in Phase 7. The Helicone cloud form sends data off-machine,
violating the privacy promise (already rejected in 008). The actual v1
need — dev-time request/latency/token logging — does not justify standing up
an analytics platform.

**Alternatives considered:**
- Thin in-house local Node proxy (~50 lines: forward :8788 → :11434, append
  JSONL logs to globalStorageUri/logs/) — viable and may return post-v1, but
  it is not needed to ship v1's four features, so it is deferred rather than
  built now.
- Helicone self-hosted via Docker — rejected for v1: heavy, requires Docker,
  incompatible with child-process-on-activation and zero-config.
- Helicone cloud — rejected on privacy grounds, consistent with 008.

**Consequences:**
- OllamaService takes a configurable `baseUrl`, defaulting to
  `http://localhost:11434`, so an observability proxy can be inserted later
  with no call-site changes.
- No proxy log output in v1. globalStorageUri/logs/ may still be used for
  general extension diagnostics, not Helicone logs.
- ARCHITECTURE.md, TECH_STACK.md, DATA_FLOW.md, and PHASES.md are updated to
  remove Helicone from the v1 path. The privacy invariant is unchanged: every
  HTTP call still goes to localhost only.
- Post-v1: revisit observability (a thin local proxy, or an opt-in Helicone
  cloud dashboard) under a new decision.

---

### 012 — 36GB RAM maps to Tier 3

**Decision:** A machine with exactly 36GB of unified memory maps to Tier 3
(14B chat / 3B autocomplete), not Tier 4. The tier boundaries are:
`<16 → T1`, `16–<24 → T2`, `24–36 → T3`, `>36 → T4`.

**Date:** 2026-06-01

**Why:** HARDWARE_PROFILES.md is internally ambiguous at 36GB — its summary
table lists Tier 3 as "24–36GB" and Tier 4 as "36GB+" (an overlap), while the
detailed text groups 36GB M-Pro machines (and the onboarding example, a "36GB
M3 Pro") under Tier 3. Tier 3 is the safer and more consistent reading: the
14B model (~9GB) is comfortable on 36GB, whereas the 32B model (~22GB) is tight
on a 36GB machine whose Pro-class memory bandwidth is lower than a Max. This
also matches the device the spec itself uses as the Tier 3 example.

**Alternatives considered:**
- 36GB → Tier 4 (≥36 runs the 32B model) — rejected: contradicts the detailed
  machine lists, and risks memory pressure on 36GB Pro-class machines.

**Consequences:**
- `mapMemoryToTier` uses `<= TIER_3_MAX_GB` (36) for Tier 3; `TIER_3_MAX_GB = 36`.
- Boundary unit tests assert 36 → Tier 3 and 37 → Tier 4.
- Previously recorded only as a code comment in constants.ts; now formalised
  here (logged in response to the Phase 1 Judge review).
