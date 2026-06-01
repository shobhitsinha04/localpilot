# ARCHITECTURE.md

## Overview

The extension is built as a VS Code extension in TypeScript. It has no backend 
server — everything runs locally as part of the extension host process or as 
child processes managed by the extension. Ollama runs as a local process on the 
user's machine and is called via its REST API on localhost.

## Platform

v1 targets macOS only. This simplifies hardware detection, installation 
scripting, and testing significantly. Windows and Linux are post-v1.

## High-Level Component Map

```
┌─────────────────────────────────────────────────────┐
│                    VS Code Editor                    │
│                                                      │
│  ┌─────────────────┐      ┌──────────────────────┐  │
│  │   Sidebar Panel  │      │   Inline Completions │  │
│  │   (Chat UI)      │      │   (Ghost Text)       │  │
│  └────────┬────────┘      └──────────┬───────────┘  │
│           │                          │               │
│  ┌────────▼──────────────────────────▼───────────┐  │
│  │              Extension Host (TypeScript)        │  │
│  │                                                 │  │
│  │  ┌─────────────┐  ┌──────────┐  ┌──────────┐  │  │
│  │  │   Ollama    │  │ Context  │  │ Hardware │  │  │
│  │  │   Service   │  │ Service  │  │ Detector │  │  │
│  │  └──────┬──────┘  └────┬─────┘  └────┬─────┘  │  │
│  │         │              │              │         │  │
│  │  ┌──────▼──────┐  ┌────▼─────┐       │         │  │
│  │  │   Prompt    │  │ LanceDB  │       │         │  │
│  │  │   Engine    │  │  Index   │       │         │  │
│  │  └─────────────┘  └──────────┘       │         │  │
│  │                                      │         │  │
│  │  ┌───────────────────────────────────▼──────┐  │  │
│  │  │           Onboarding Manager             │  │  │
│  │  └──────────────────────────────────────────┘  │  │
│  └─────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
          │                          │
          ▼                          ▼
   ┌─────────────┐          ┌────────────────┐
   │   Ollama    │          │   Helicone     │
   │  (localhost │          │  (localhost    │
   │   :11434)   │          │   proxy)       │
   └─────────────┘          └────────────────┘
```

## Components

### Extension Host
The core TypeScript process that VS Code runs. Orchestrates all other 
components. Activated when VS Code opens a workspace folder.

### Sidebar Panel (Chat UI)
A VS Code WebviewPanel rendered in the primary sidebar. Built with plain 
HTML/CSS/JS inside the webview. Communicates with the extension host via 
VS Code's message passing API (postMessage). Styled to feel like Cursor's 
chat panel.

### Inline Completions
Registered as a VS Code InlineCompletionItemProvider. Triggered when the 
user pauses typing. Sends surrounding code context to Ollama and returns 
ghost text suggestions. Debounced to avoid hammering the local model.

### Ollama Service
Wrapper around Ollama's REST API (localhost:11434). Handles:
- Checking if Ollama is installed and running
- Pulling models
- Sending chat and completion requests
- Streaming responses back to the UI
All calls are routed through Helicone's local proxy for observability.

### Context Service
Responsible for retrieving relevant code context for any given query.
- On workspace open: indexes all code files into LanceDB
- On query: performs semantic search against the index to find relevant files
- Assembles retrieved chunks into a context block for the prompt
- Watches for file changes and updates the index incrementally

### Hardware Detector
Runs once on first activation. Detects:
- Available RAM
- Apple Silicon vs Intel (for GPU inference capability)
- Disk space available
Maps detected hardware to a model tier (see HARDWARE_PROFILES.md).

### Prompt Engine
Assembles the final prompt sent to Ollama. Takes:
- User's message or code context
- Retrieved codebase chunks from Context Service
- Conversation history
- System prompt
Outputs a structured prompt appropriate for the selected model.

### Onboarding Manager
Runs on first install. Orchestrates the full setup sequence:
1. Detect hardware
2. Check/install Ollama
3. Pull the appropriate model
4. Index the current workspace
5. Show the user the extension is ready
Handles errors and edge cases at each step (see ONBOARDING_FLOW.md).

### LanceDB Index
Embedded vector database stored on disk inside the extension's global 
storage directory. No separate process. Stores embeddings of all code files 
in the current workspace. One index per workspace.

### Helicone (Local Proxy)
Sits between the Ollama Service and Ollama itself. Every LLM call passes 
through it. Provides:
- Request/response logging
- Latency tracking
- Error visibility
- Token usage tracking
Runs locally — no data leaves the machine. Used purely for observability 
during development and debugging.

## Communication Patterns

### Webview ↔ Extension Host
Uses VS Code's built-in postMessage API. Webview sends user actions 
(message sent, settings changed). Extension host sends responses 
(streaming tokens, status updates, errors).

### Extension Host ↔ Ollama
HTTP REST calls to localhost:11434 via Helicone proxy. Streaming responses 
handled via async generators, tokens forwarded to webview as they arrive.

### Extension Host ↔ LanceDB
Direct function calls via the LanceDB TypeScript SDK. Synchronous for 
queries, async for indexing operations.

## Data Storage

All data lives in VS Code's globalStorageUri for the extension:

```
~/.vscode/extensions/localpilot/
├── models/          # Managed by Ollama, not us
├── index/           # LanceDB vector index (per workspace)
├── config.json      # User preferences, selected model, onboarding state
└── logs/            # Helicone local logs
```

Nothing is stored outside this directory. Nothing is transmitted externally.

## What This Architecture Intentionally Avoids

- No backend server of any kind
- No cloud API calls (except optionally Helicone cloud if user opts in 
  post-v1 — off by default)
- No separate database process (LanceDB is embedded)
- No electron or custom app shell — pure VS Code extension
- No telemetry of any kind in v1
