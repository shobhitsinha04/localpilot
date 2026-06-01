# PHASES.md

## Overview

This file defines what gets built in what order. Each phase has a clear
scope, a definition of done, and a list of Linear issues to create before
starting. No phase begins until the previous phase is fully complete and
signed off by both team members.

The rule: get something working end-to-end before making it good.
A working ugly thing beats a beautiful incomplete thing every time.

---

## Phase 0 — Project Setup
**Goal:** Both developers can run a hello-world VS Code extension locally
and have all tooling configured.

### Tasks
- [ ] Initialise VS Code extension project with `yo code`
- [ ] Configure TypeScript (tsconfig.json targeting ES2022, CommonJS)
- [ ] Configure esbuild for bundling
- [ ] Configure ESLint + Prettier with shared config
- [ ] Set up Vitest for unit testing
- [ ] Create the docs/ folder and commit all spec markdown files
- [ ] Create Linear project and import all Phase 1 issues
- [ ] Verify: both developers can press F5 in VS Code and see
      "Hello World" notification from the extension
- [ ] Set up Git repository with a clear branching strategy:
      main (stable) → dev (integration) → feature branches

### Definition of Done
Both developers have the extension running locally. Linting and
formatting are enforced. The repository is set up and both developers
have pushed a commit.

---

## Phase 1 — Ollama Integration + Hardware Detection
**Goal:** The extension can detect hardware, pick the right model,
install Ollama if needed, download the model, and run a basic prompt.
No UI beyond VS Code notifications and output channel.

### Tasks

**Hardware Detector**
- [ ] Implement `HardwareDetector.detect()` — reads RAM, chip, disk,
      macOS version via child_process exec of system commands
- [ ] Implement tier mapping logic (see HARDWARE_PROFILES.md)
- [ ] Unit tests for all tier boundary conditions
- [ ] Handle Intel Mac detection — show clear unsupported message

**Ollama Service (core)**
- [ ] Implement `OllamaService.isInstalled()` — checks binary exists
- [ ] Implement `OllamaService.isRunning()` — pings localhost:11434
- [ ] Implement `OllamaService.install()` — runs official install script
      via child_process
- [ ] Implement `OllamaService.start()` — starts ollama serve as
      background child process
- [ ] Implement `OllamaService.pullModel(modelName)` — calls ollama pull,
      parses stdout for progress, emits progress events
- [ ] Implement `OllamaService.chat(messages, model)` — POST /api/chat,
      returns async generator of tokens
- [ ] Implement `OllamaService.complete(prompt, model)` — POST /api/generate,
      returns string
- [ ] Implement `OllamaService.embed(text, model)` — POST /api/embeddings,
      returns float[]

**Helicone Local Proxy**
- [ ] Set up Helicone local proxy as a child process started on activation
- [ ] Route all OllamaService HTTP calls through proxy port
- [ ] Verify logs are written to globalStorageUri/logs/

**Config Manager**
- [ ] Implement `ConfigManager` — reads/writes config.json in
      globalStorageUri
- [ ] Schema: { onboardingComplete, tier, chatModel, autocompleteModel,
      embeddingModel, workspaceIndexes: {} }

**Smoke Test**
- [ ] On extension activation: detect hardware, install Ollama if needed,
      pull the correct model, send "say hello" to the model, log the
      response to VS Code Output Channel
- [ ] This is not user-facing yet — it's a developer smoke test

### Definition of Done
Running the extension on a fresh Mac installs Ollama, downloads the
correct model for the hardware, sends a test prompt, and logs the
response. All unit tests pass. Both developers have verified this
on their own machines.

---

## Phase 2 — Codebase Indexing
**Goal:** The extension can index a workspace into LanceDB and retrieve
relevant chunks via semantic search.

### Tasks

**File Walker**
- [ ] Implement `FileWalker.walk(workspacePath)` — returns all indexable
      file paths
- [ ] Skip logic: node_modules, .git, dist, build, __pycache__, binary
      files, files > 500KB
- [ ] Implement .gitignore parsing using the `ignore` package
- [ ] Unit tests for skip logic with a mock directory structure

**Chunker**
- [ ] Implement `Chunker.chunk(fileContent, filename)` — splits file into
      overlapping 150-line chunks with 20-line overlap
- [ ] Each chunk tagged with: filename, startLine, endLine
- [ ] Unit tests for chunking behaviour at file boundaries

**Index Manager**
- [ ] Set up LanceDB connection in globalStorageUri/index/
- [ ] Implement `IndexManager.indexWorkspace(workspacePath)` — walks,
      chunks, embeds, stores. Processes files in batches of 5.
- [ ] Implement `IndexManager.search(query)` — embeds query, searches
      LanceDB, returns top 20 chunks
- [ ] Implement `IndexManager.rerank(chunks, query)` — re-ranks by
      combined similarity + recency score, returns top 8
- [ ] Implement `IndexManager.updateFile(filePath)` — deletes existing
      chunks for file, re-indexes
- [ ] Implement `IndexManager.deleteFile(filePath)` — removes chunks
- [ ] Implement `IndexManager.isIndexed(workspaceHash)` — checks if
      index exists for this workspace
- [ ] Set up file system watcher for incremental updates
- [ ] Set up proper-lockfile to prevent concurrent index writes
- [ ] Unit tests for search and rerank logic

**Smoke Test**
- [ ] On activation: index the current workspace, run a test query,
      log the top 3 retrieved chunks to Output Channel
- [ ] Verify incremental update: save a file, verify the index updates

### Definition of Done
Opening a workspace indexes all code files. A test query returns
relevant chunks. Saving a file updates the index. Both developers
verified on a real codebase of 100+ files.

---

## Phase 3 — Sidebar Chat (Basic)
**Goal:** A working chat panel in the VS Code sidebar. No @codebase yet.
Just chat with the current file as context.

### Tasks

**Webview Setup**
- [ ] Register WebviewViewProvider in extension manifest
- [ ] Create sidebar icon in activity bar
- [ ] Implement basic webview HTML/CSS — header, message list,
      input area
- [ ] Style with VS Code CSS variables for theme compatibility
- [ ] Implement postMessage bridge between webview and extension host
- [ ] Unit test message passing protocol

**Conversation Manager**
- [ ] Implement `ConversationManager` — maintains in-memory message
      history array
- [ ] Implement history trimming when context window approached
- [ ] Implement `ConversationManager.clear()` — clears history

**Prompt Engine (Chat)**
- [ ] Implement `PromptEngine.buildChatPrompt(userMessage, history,
      fileContext)` — assembles full message array for Ollama
- [ ] Implement context injection for current file
- [ ] Unit tests for prompt assembly and context trimming

**Chat Flow**
- [ ] Wire user input → Prompt Engine → Ollama Service → streaming
      tokens → webview
- [ ] Implement "Stop" button that cancels in-flight request
- [ ] Implement "New Chat" button that clears conversation
- [ ] Implement markdown rendering with marked.js
- [ ] Implement syntax highlighting with highlight.js
- [ ] Implement copy button on code blocks

**Error Handling**
- [ ] Ollama not running → show inline error with restart action
- [ ] Request timeout → show inline error
- [ ] Empty response → show inline error

### Definition of Done
User opens sidebar, types a question about their current file, gets
a streaming markdown response. New Chat clears conversation. Stop
cancels the response. Errors are handled gracefully. Both developers
tested on their own machines.

---

## Phase 4 — Inline Completions (Tab Autocomplete)
**Goal:** Ghost text completions appear when the user pauses typing.

### Tasks

**Completion Provider**
- [ ] Register `InlineCompletionItemProvider` for all supported languages
- [ ] Implement 600ms debounce
- [ ] Implement AbortController cancellation for superseded requests
- [ ] Implement 3000ms timeout

**Prompt Engine (Completion)**
- [ ] Implement `PromptEngine.buildFIMPrompt(prefix, suffix, filename,
      language)` — assembles Fill-in-the-Middle format prompt
- [ ] Unit tests for FIM prompt format

**Completion Flow**
- [ ] Wire: user pauses → Prompt Engine → OllamaService.complete() →
      InlineCompletionItem returned to VS Code
- [ ] Verify Tab accepts, Escape dismisses
- [ ] Verify no completion fires when Ollama is not running

### Definition of Done
Pausing while typing in a Python or TypeScript file shows a ghost text
suggestion within 2 seconds. Tab accepts it. Multiple rapid keystrokes
do not send multiple requests. Both developers tested on their own machines.

---

## Phase 5 — CMD+K Inline Editing
**Goal:** Select code, press CMD+K, type an instruction, see the code
rewritten with a diff view.

### Tasks

**Input Box**
- [ ] Register CMD+K keybinding in package.json
- [ ] Implement inline input box decoration above selection
- [ ] Escape cancels without making changes

**Prompt Engine (Edit)**
- [ ] Implement `PromptEngine.buildEditPrompt(instruction, selection,
      prefix, suffix, filename, language)` — assembles edit prompt
- [ ] Unit tests for edit prompt format

**Edit Flow**
- [ ] Wire: CMD+K → input box → instruction submitted → Prompt Engine →
      OllamaService.complete() streaming → replace selection in real time
- [ ] Implement diff computation (original vs new)
- [ ] Implement VS Code decorations for red/green diff highlighting
- [ ] Implement Accept (CMD+Enter) — finalise new code
- [ ] Implement Reject (Escape) — restore original selection exactly

### Definition of Done
Selecting code and pressing CMD+K opens an input box. Submitting an
instruction streams the rewritten code in place with a diff view.
Accept and Reject both leave the file in a clean state. Both developers
tested with selections from 1 to 100 lines.

---

## Phase 6 — @codebase + Onboarding UI
**Goal:** Wire @codebase retrieval into chat. Build the full onboarding
UI. The product is now feature-complete for v1.

### Tasks

**@codebase**
- [ ] Detect @codebase token in chat input
- [ ] Wire: @codebase detected → IndexManager.search() →
      IndexManager.rerank() → context block assembled →
      Prompt Engine → Ollama
- [ ] Show "Searching codebase..." status in UI
- [ ] Show retrieved file name chips in UI
- [ ] Handle: index not ready, no files found

**Onboarding UI**
- [ ] Implement full onboarding flow in the webview
      (see ONBOARDING_FLOW.md for all steps)
- [ ] Step 0: Welcome screen
- [ ] Step 1: Hardware detection with result displayed
- [ ] Step 2: Model selection announcement
- [ ] Step 3: Ollama install with progress
- [ ] Step 4: Model download with progress bar + time estimate
- [ ] Step 5: Codebase indexing with file count progress
- [ ] Step 6: Ready screen with usage tips
- [ ] Implement resume from interrupted onboarding
- [ ] Implement `LocalPilot: Reset and Re-run Setup` command

**Final Wiring**
- [ ] Ensure onboarding gates all features — no features active until
      onboarding complete
- [ ] Verify config.json state machine is correct across all flows

### Definition of Done
A fresh install on a machine that has never had Ollama goes through
the full onboarding flow without any manual steps and ends with all
four features working. @codebase returns relevant results. Both
developers tested on a clean machine.

---

## Phase 7 — Polish, Testing, and Private Beta
**Goal:** The product is stable enough to give to 10 real users.

### Tasks
- [ ] Full error handling audit — every possible failure state handled
- [ ] Performance testing — index a 500-file codebase, measure time
- [ ] Completion latency testing across all hardware tiers
- [ ] README written for beta users
- [ ] Package extension as .vsix for distribution
- [ ] Recruit 10 beta users (target: developers at companies with
      data privacy concerns)
- [ ] Set up feedback channel (GitHub Issues or Linear)
- [ ] Fix all bugs reported in first week of beta

### Definition of Done
10 real users have installed LocalPilot and used it for at least
one real coding session. Critical bugs are fixed. Feedback is collected
and logged as Linear issues for post-beta prioritisation.

---

## Phase Summary

| Phase | Focus                        |
|-------|------------------------------|
| 0     | Project setup                |
| 1     | Ollama + hardware detection  |
| 2     | Codebase indexing            |
| 3     | Sidebar chat                 |
| 4     | Inline completions           |
| 5     | CMD+K inline editing         |
| 6     | @codebase + onboarding UI    |
| 7     | Polish + private beta        |

---

## Rules for All Phases

1. No phase skipping — each phase builds on the last
2. Both developers must test every feature on their own machine
   before a phase is marked done
3. Every bug found during a phase gets logged as a Linear issue
   before moving on — nothing is "we'll fix it later" unless it's
   explicitly logged
4. The Judge Agent reviews all code before a phase is closed
5. The Documenter Agent updates CHANGELOG.md at the end of every phase
