# FEATURES.md

## Overview

This file defines every feature in LocalPilot v1. Each feature is written
as a precise specification — what triggers it, what happens, what the user
sees, and what done means. Claude Code should treat this as the source of
truth for what to build.

Features are grouped into four areas:
1. Inline Completions (tab autocomplete)
2. Inline Code Editing (CMD+K)
3. Sidebar Chat
4. Codebase Context (@codebase)

---

## 1. Inline Completions (Tab Autocomplete)

### What It Is
Ghost text suggestions that appear as the user types. Pressing Tab accepts
the suggestion. Pressing Escape or continuing to type dismisses it.

### Trigger
- User pauses typing for 600ms in any code file
- The file must be a recognised code file (not markdown, JSON config, etc.)
- Ollama must be running and the autocomplete model must be loaded

### What Gets Sent to the Model
A prompt assembled by the Prompt Engine containing:
- The 20 lines of code above the cursor (prefix)
- The 10 lines of code below the cursor (suffix)
- The filename and language identifier
- A system prompt instructing the model to complete the code at the cursor

The prompt uses Fill-in-the-Middle (FIM) format which Qwen2.5-Coder
supports natively. This tells the model to generate only what fits
between the prefix and suffix.

### What the User Sees
Ghost text appears inline at the cursor position in VS Code's standard
grey italic style. It shows the model's suggested completion.

Single-line completions are shown immediately. Multi-line completions
show the first line immediately, with subsequent lines revealed as the
user continues pressing Tab.

### Accepting / Rejecting
- `Tab` — accept the full suggestion
- `CMD+Right Arrow` — accept word by word
- `Escape` or any other key — dismiss the suggestion

### Debouncing
- Completions are debounced at 600ms — if the user types again before
  600ms, the timer resets and no request is sent
- Only one completion request is in flight at a time — if a new trigger
  fires before the previous response arrives, the previous request is
  cancelled
- If the model takes longer than 3 seconds to respond, the request is
  silently cancelled (no error shown to the user)

### What Done Means
- Ghost text appears within 1-2 seconds of the user pausing on Tier 2+
- Suggestions are contextually relevant to the surrounding code
- Tab accepts, Escape dismisses, no crashes or freezes
- Works across: Python, JavaScript, TypeScript, Go, Rust, Swift, Java,
  C, C++, Ruby, PHP, Kotlin

---

## 2. Inline Code Editing (CMD+K)

### What It Is
The user selects a block of code, presses CMD+K, types an instruction
in a small input box, and the selected code is rewritten in place
according to the instruction. Equivalent to Cursor's CMD+K.

### Trigger
- User selects one or more lines of code
- User presses CMD+K
- A small inline input box appears just above the selection

### The Input Box
- Appears as a floating input field directly above the selected code
- Placeholder text: "Ask LocalPilot to edit this code..."
- Single line input, Enter to submit, Escape to cancel
- No other UI elements — just the input field

### What Gets Sent to the Model
A prompt assembled by the Prompt Engine containing:
- The user's instruction
- The selected code block with clear delimiters
- 10 lines of code above the selection for context
- 10 lines of code below the selection for context
- The filename and language identifier
- A system prompt instructing the model to rewrite only the selected
  block according to the instruction, returning only code with no
  explanation

### What the User Sees After Submitting
1. The selected code is replaced with a loading indicator
   (e.g. subtle pulsing highlight on the selection)
2. The new code streams in, replacing the old code token by token
3. Once complete, a diff view is shown:
   - Removed lines highlighted in red
   - Added lines highlighted in green
   - Two buttons appear: "Accept" (CMD+Enter) and "Reject" (Escape)

### Accepting / Rejecting
- "Accept" (CMD+Enter) — finalises the new code, diff view dismissed
- "Reject" (Escape) — reverts to the original selected code exactly
- If VS Code loses focus before a decision is made — treat as Reject,
  revert to original

### What Done Means
- CMD+K opens the input box over selected code
- Submitting sends the instruction and streams back rewritten code
- Diff view shows clearly what changed
- Accept and Reject both work correctly and leave the file in a
  clean state
- Works for selections ranging from 1 line to 200 lines

---

## 3. Sidebar Chat

### What It Is
A persistent chat panel in the VS Code primary sidebar. The user can
ask questions, get explanations, request code generation, and have a
multi-turn conversation with the model. The model has awareness of the
currently open file and can search the codebase when asked.

### Location
Registered as a VS Code WebviewViewProvider in the primary sidebar.
Icon in the activity bar (left edge of VS Code). Clicking the icon
opens/closes the panel.

### Chat Interface Layout
From top to bottom:
- **Header bar:** "LocalPilot" title, model name shown in small text,
  a "New Chat" button (clears conversation), a settings icon (post-v1)
- **Conversation area:** scrollable message history, newest messages
  at the bottom
- **Input area:** multi-line text input with a Send button and a
  paperclip icon for attaching the current file (post-v1)

### Message Display
**User messages:**
- Right-aligned, subtle background colour
- Plain text, no markdown rendering

**Model responses:**
- Left-aligned, no background
- Full markdown rendering including:
  - Syntax-highlighted code blocks with a copy button
  - Bold, italic, bullet lists, numbered lists
  - Inline code
- Responses stream in token by token — text appears as it is generated,
  not all at once

### Multi-Turn Conversation Memory
- The full conversation history is maintained for the duration of the
  VS Code session
- Every message sent to the model includes the complete prior conversation
  as context (up to the model's context window limit)
- If the conversation exceeds the context window, the oldest messages are
  trimmed from the history sent to the model, but they remain visible in
  the UI
- Clicking "New Chat" clears both the UI and the in-memory history
- Conversation history is NOT persisted to disk — closing VS Code clears it

### Automatic Context (Current File)
Without the user doing anything, every chat message automatically includes:
- The name and language of the currently active file
- The contents of the currently active file (if under 500 lines)
- The current cursor position and any selected text

This context is injected silently into the system prompt. The user does
not see it explicitly but the model uses it to give relevant answers.

### Streaming Behaviour
- Responses stream token by token into the UI
- A "Stop" button appears while a response is streaming — clicking it
  cancels the request and keeps whatever text has already appeared
- The input field is disabled while a response is streaming

### Error States
- Ollama not running → show inline error: "LocalPilot isn't running.
  Click here to restart it." with a clickable restart action
- Model not loaded → show inline error with a reload button
- Empty response from model → show: "No response received. Try again."
- Request timeout (>30 seconds) → cancel and show: "This took too long.
  Try a shorter question or restart LocalPilot."

### What Done Means
- User can open the sidebar panel and type a question
- Response streams back with markdown rendering
- Code blocks have syntax highlighting and a copy button
- Conversation persists across multiple messages in the same session
- New Chat clears the conversation
- Current file context is automatically included

---

## 4. Codebase Context (@codebase)

### What It Is
When the user types @codebase at the start of a chat message, the
Context Service performs a semantic search across the entire indexed
codebase to find the most relevant files and code chunks, and includes
them in the prompt sent to the model. This allows the user to ask
questions about code they are not currently looking at.

### Trigger
- User types `@codebase` anywhere in the chat input
- The `@codebase` token is recognised and triggers the retrieval pipeline

### What the User Sees
After submitting a message with @codebase:
1. A brief status line appears above the response area:
   > "Searching codebase... found 4 relevant files"
2. The relevant file names are shown as small chips/tags:
   > `auth.ts` `middleware.ts` `routes/user.ts` `types.ts`
3. The model's response streams in below, informed by those files

The user can see exactly which files were used — no black box.

### What Gets Sent to the Model
A prompt containing:
- The user's question (with @codebase removed from the text)
- Up to 8 most relevant code chunks retrieved from LanceDB
- Each chunk labelled with its filename and line numbers
- The currently active file (as always)
- The conversation history

### Retrieval Process
1. The user's question is embedded using `nomic-embed-text`
2. The embedding is used to query the LanceDB index
3. The top 20 candidate chunks are retrieved
4. Chunks are re-ranked by relevance using a simple scoring heuristic
   (recency + semantic similarity score)
5. The top 8 chunks are selected and assembled into the context block
6. The context block is injected into the prompt

### When @codebase Is Not Available
- Codebase has not been indexed yet → show inline message:
  "Codebase indexing is still in progress. Try again in a moment."
- Workspace has no indexable files → show inline message:
  "No code files found to search."

### Incremental Index Updates
- The Context Service watches the workspace for file changes using
  VS Code's `workspace.createFileSystemWatcher`
- When a file is saved, its chunks are re-embedded and the LanceDB
  index is updated in the background
- This happens silently with no UI indication unless it fails
- New files added to the workspace are indexed automatically
- Deleted files are removed from the index automatically

### What Done Means
- Typing @codebase in chat triggers a codebase search
- The names of retrieved files are shown to the user
- The model's response is visibly informed by the codebase content
- The index updates when files are saved
- Works on codebases up to 1000 files without significant delay

---

## Feature Availability Matrix

| Feature                  | v1  | Post-v1 |
|--------------------------|-----|---------|
| Tab autocomplete          | ✓   |         |
| CMD+K inline editing      | ✓   |         |
| Sidebar chat              | ✓   |         |
| @codebase retrieval       | ✓   |         |
| Multi-turn memory         | ✓   |         |
| Conversation persistence  |     | ✓       |
| File attachment in chat   |     | ✓       |
| Model switching           |     | ✓       |
| @file reference in chat   |     | ✓       |
| Team/shared config        |     | ✓       |
| Windows / Linux support   |     | ✓       |
| Helicone cloud dashboard  |     | ✓       |

---

## Out of Scope for v1

- Voice input
- Image / screenshot input
- Terminal integration
- Git diff awareness
- Test generation as a dedicated feature
- Any feature that requires an internet connection
