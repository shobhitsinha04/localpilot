# DATA_FLOW.md

## Overview

This file documents exactly how data moves through LocalPilot for every
major operation. Claude Code should reference this file when implementing
any service that touches data — prompts, embeddings, streaming responses,
or file indexing.

Every flow starts at the user and ends at the user. Nothing exits the
machine at any point.

---

## 1. Inline Completion Flow

```
User pauses typing (600ms debounce)
        │
        ▼
VS Code InlineCompletionItemProvider.provideInlineCompletionItems()
        │
        ▼
Prompt Engine — assembles FIM prompt
  ├── prefix: 20 lines above cursor
  ├── suffix: 10 lines below cursor
  ├── filename + language ID
  └── system prompt: "Complete the code at <fim_middle>. Return only code."
        │
        ▼
Ollama Service — POST localhost:11434/api/generate
  ├── model: autocomplete model from config.json
  ├── prompt: assembled FIM prompt
  ├── stream: false (completions are not streamed, returned whole)
  ├── options: { temperature: 0.1, top_p: 0.95, stop: ["\n\n"] }
  └── routed via Helicone local proxy
        │
        ▼
Ollama returns completion text
        │
        ▼
Ollama Service — returns raw string
        │
        ▼
Inline Completion Provider — wraps in InlineCompletionItem
        │
        ▼
VS Code renders ghost text at cursor position
        │
        ▼
User presses Tab → code inserted
User presses Escape → ghost text dismissed
```

**Timeout:** If Ollama does not respond within 3000ms, the request is
aborted and no ghost text is shown. No error is surfaced to the user.

**Cancellation:** If the user types before the response arrives, the
pending request is cancelled via AbortController.

---

## 2. CMD+K Inline Edit Flow

```
User selects code → presses CMD+K
        │
        ▼
Extension registers text selection range
        │
        ▼
Inline input box renders above selection (VS Code decoration)
        │
        ▼
User types instruction → presses Enter
        │
        ▼
Prompt Engine — assembles edit prompt
  ├── system prompt: "Rewrite the selected code according to the
  │    instruction. Return only the rewritten code, no explanation."
  ├── 10 lines above selection (context)
  ├── selected code block (clearly delimited)
  ├── 10 lines below selection (context)
  ├── filename + language ID
  └── user instruction
        │
        ▼
Ollama Service — POST localhost:11434/api/generate
  ├── model: chat model from config.json
  ├── prompt: assembled edit prompt
  ├── stream: true
  ├── options: { temperature: 0.2, top_p: 0.95 }
  └── routed via Helicone local proxy
        │
        ▼
Ollama streams response tokens
        │
        ▼
Ollama Service — async generator yields tokens
        │
        ▼
Extension Host — buffers streamed tokens into complete response
        │
        ▼
Original selection replaced with streamed code in real time
        │
        ▼
Diff view computed (original selection vs new code)
        │
        ▼
VS Code decorations render red/green diff highlighting
        │
        ▼
User presses CMD+Enter → Accept
  └── decorations cleared, new code finalised in document

User presses Escape → Reject
  └── new code removed, original selection restored exactly
```

---

## 3. Sidebar Chat Flow (Without @codebase)

```
User types message → presses Enter or clicks Send
        │
        ▼
Webview — postMessage({ type: 'userMessage', text: '...' })
        │
        ▼
Extension Host — receives message event
        │
        ▼
Conversation Manager — appends user message to in-memory history
        │
        ▼
Context Service — gathers automatic context
  ├── currently active file name + language
  ├── currently active file contents (if < 500 lines)
  └── current cursor position + selected text (if any)
        │
        ▼
Prompt Engine — assembles chat prompt
  ├── system prompt: "You are a coding assistant. You have access to
  │    the user's current file. Answer concisely and accurately."
  ├── current file context block
  ├── full conversation history (trimmed if exceeds context window)
  └── user message
        │
        ▼
Ollama Service — POST localhost:11434/api/chat
  ├── model: chat model from config.json
  ├── messages: assembled prompt as message array
  ├── stream: true
  ├── options: { temperature: 0.7, top_p: 0.95 }
  └── routed via Helicone local proxy
        │
        ▼
Ollama streams response tokens
        │
        ▼
Ollama Service — async generator yields token strings
        │
        ▼
Extension Host — for each token:
  └── postMessage({ type: 'streamToken', token: '...' }) → Webview
        │
        ▼
Webview — appends token to current assistant message bubble
  └── markdown re-rendered incrementally as tokens arrive
        │
        ▼
Ollama stream ends
        │
        ▼
Extension Host — postMessage({ type: 'streamEnd' })
        │
        ▼
Webview — finalises message bubble, re-enables input field
        │
        ▼
Conversation Manager — appends complete assistant response to history
```

---

## 4. Sidebar Chat Flow (With @codebase)

```
User types "@codebase <question>" → presses Enter
        │
        ▼
Webview — postMessage({ type: 'userMessage', text: '@codebase ...' })
        │
        ▼
Extension Host — detects @codebase token in message text
        │
        ▼
Webview notified — postMessage({ type: 'retrievalStart' })
  └── UI shows: "Searching codebase..."
        │
        ▼
Context Service — RAG retrieval pipeline
  │
  ├── 1. Strip @codebase from query text
  │
  ├── 2. Embed the query
  │       └── POST localhost:11434/api/embeddings
  │             ├── model: nomic-embed-text
  │             └── prompt: cleaned query text
  │             → returns: float[] embedding vector
  │
  ├── 3. Query LanceDB index
  │       └── vectorSearch(embedding, limit: 20)
  │             → returns: top 20 chunks with similarity scores
  │
  ├── 4. Re-rank results
  │       └── sort by: (0.7 × similarity score) + (0.3 × recency score)
  │             → returns: top 8 chunks
  │
  └── 5. Assemble context block
          └── for each chunk:
                "// File: <filename> (lines <start>-<end>)
                 <code chunk>"
        │
        ▼
Extension Host — postMessage({ type: 'retrievalComplete', files: [...] })
  └── UI shows file name chips for retrieved files
        │
        ▼
Prompt Engine — assembles @codebase prompt
  ├── system prompt: "You are a coding assistant with access to the
  │    user's codebase. Use the provided code context to answer
  │    accurately. Cite file names when referencing specific code."
  ├── retrieved codebase context block (8 chunks, labelled)
  ├── current file context
  ├── conversation history
  └── user question (without @codebase token)
        │
        ▼
[Continues identically to Chat Flow steps from Ollama Service onwards]
```

---

## 5. Codebase Indexing Flow (Initial)

```
Workspace opens → Onboarding complete (or re-index triggered)
        │
        ▼
Context Service — startIndexing(workspacePath)
        │
        ▼
File Walker — recursively walks workspace directory
  ├── skip: node_modules, .git, dist, build, __pycache__
  ├── skip: files matching .gitignore patterns
  ├── skip: binary files (detected by extension + null byte check)
  ├── skip: files > 500KB
  └── collect: all remaining code files → string[]
        │
        ▼
For each file:
  │
  ├── Read file contents
  │
  ├── Chunk into overlapping segments
  │     ├── chunk size: 150 lines
  │     ├── overlap: 20 lines (so context isn't lost at chunk boundaries)
  │     └── each chunk tagged with: filename, start line, end line
  │
  └── For each chunk:
        └── POST localhost:11434/api/embeddings
              ├── model: nomic-embed-text
              └── prompt: chunk text
              → returns: float[] embedding vector
              │
              ▼
        LanceDB — insert({ embedding, text, filename, startLine, endLine })
        │
        ▼
Progress reported to Onboarding Manager after each file
  └── postMessage({ type: 'indexProgress', current: N, total: M })
        │
        ▼
All files processed
        │
        ▼
Context Service — marks index as complete in config.json
  └── { indexed: true, fileCount: N, workspaceHash: '...' }
```

**Concurrency:** Files are embedded in batches of 5 (not one at a time,
not all at once). This balances speed against overwhelming Ollama.

---

## 6. Incremental Index Update Flow

```
User saves a file (workspace.createFileSystemWatcher fires)
        │
        ▼
Context Service — onFileChanged(filePath)
        │
        ▼
LanceDB — delete all existing chunks where filename === filePath
        │
        ▼
Read updated file contents
        │
        ▼
Chunk + embed (same as steps in Indexing Flow above)
        │
        ▼
LanceDB — insert new chunks
        │
        ▼
Done — no UI indication unless error occurs
```

---

## 7. Helicone Local Proxy Flow

```
Any Ollama Service call
        │
        ▼
HTTP request constructed for localhost:11434
        │
        ▼
Request routed through Helicone local proxy (localhost:8788)
  └── Helicone intercepts, logs:
        ├── timestamp
        ├── model name
        ├── prompt (sanitised — no file contents logged in v1)
        ├── response
        ├── latency
        └── token count
        │
        ▼
Helicone forwards request to Ollama at localhost:11434
        │
        ▼
Ollama responds → Helicone forwards response back
        │
        ▼
Ollama Service receives response — continues normally
```

**Privacy note:** In v1, Helicone runs entirely locally. Logs are written
to `~/.vscode/extensions/localpilot/logs/` only. No data is sent to
Helicone's cloud. The local proxy is used purely for development
observability.

---

## Context Window Management

Every model has a maximum context window. When conversation history +
context blocks approach this limit, the Prompt Engine trims as follows:

**Trim priority (what gets cut first):**
1. Oldest conversation turns (beyond the last 10 exchanges)
2. Codebase context chunks (reduce from 8 to 4)
3. Current file contents (truncate to first 100 lines)

**What is never trimmed:**
- The system prompt
- The user's current message
- The most recent 2 conversation turns

**Context window limits by model:**
| Model                  | Context Window |
|------------------------|----------------|
| qwen2.5-coder:1.5b     | 32K tokens     |
| qwen2.5-coder:3b       | 32K tokens     |
| qwen2.5-coder:7b       | 128K tokens    |
| qwen2.5-coder:14b      | 128K tokens    |
| qwen2.5-coder:32b      | 128K tokens    |

In practice, context window limits are unlikely to be hit in normal
usage for 7B and above. The trim logic is a safety net, not a
frequent code path.
