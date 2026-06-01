# ONBOARDING_FLOW.md

## Overview

Onboarding is the most important UX moment in the product. A user who installs
the extension and has it working in under 5 minutes will trust it. A user who
hits a confusing error or has to google something will uninstall it.

Every step below must have a visible progress indicator in the sidebar panel.
The user should always know what is happening and roughly how long it will take.
No silent failures. No unexplained waits.

---

## Trigger

Onboarding runs automatically the first time the extension activates. It is
triggered when:
- VS Code opens with the extension installed for the first time
- `config.json` does not exist or `onboardingComplete` is false

It does not run again after successful completion unless the user manually
resets via the command palette.

---

## The Happy Path

### Step 0 — Welcome Screen
**What the user sees:**
The sidebar panel opens automatically showing:
> "Welcome to LocalPilot.
> We're going to set everything up for you. This takes 5-15 minutes
> depending on your internet speed (just for the model download — after
> this, everything runs offline forever).
> Nothing you type will ever leave your machine."

A single "Get Started" button. Nothing else. No settings, no options.

**What happens in the background:** Nothing yet.

---

### Step 1 — Hardware Detection
**What the user sees:**
> "Detecting your hardware..."
> *(spinner, takes < 2 seconds)*
> "Detected: MacBook Pro M3 Pro — 36GB unified memory. ✓"

**What happens in the background:**
- Read total RAM via `sysctl hw.memsize`
- Read chip info via `sysctl machdep.cpu.brand_string`
- Check available disk space via `statvfs`
- Check macOS version via `sw_vers`
- Map to hardware tier (see HARDWARE_PROFILES.md)
- Write result to `config.json`

**Error states:**
- Detection fails → default to Tier 2, log the failure, continue silently
- macOS below Ventura → show warning about slower performance, continue
- Intel Mac detected → show "LocalPilot v1 supports Apple Silicon only.
  Intel support is coming. Join the waitlist." Stop onboarding.

---

### Step 2 — Model Selection Announcement
**What the user sees:**
Based on tier, show the appropriate message. Example for Tier 2:
> "Based on your hardware, we've selected:
> • Chat: Qwen2.5-Coder 7B (~4.7GB)
> • Autocomplete: Qwen2.5-Coder 1.5B (~1GB)
>
> These models are optimised for your machine and will give you the
> best balance of speed and quality."

For Tier 1 (8GB), additionally show:
> "Note: Your machine has 8GB RAM. LocalPilot will work, but responses
> will be slower and less detailed than on machines with more memory."

A single "Download Models" button.

**What happens in the background:** Nothing yet, waiting for user to confirm.

---

### Step 3 — Ollama Check and Install
**What the user sees:**
> "Checking for Ollama..."

If already installed:
> "Ollama found. ✓"

If not installed:
> "Installing Ollama... (this takes about 30 seconds)"
> *(progress bar)*
> "Ollama installed. ✓"

**What happens in the background:**
- Check if `ollama` binary exists at known macOS paths
  (`/usr/local/bin/ollama`, `/opt/homebrew/bin/ollama`)
- Check if Ollama is running by pinging `localhost:11434/api/tags`
- If not installed: download the Ollama macOS installer silently using
  the official install script via a child process
- If installed but not running: start the Ollama daemon via
  `ollama serve` as a background child process
- Verify it's running by pinging the API again

**Error states:**
- Install fails due to permissions → prompt user to install Ollama
  manually, provide direct link to ollama.com/download, offer a
  "I've installed it" button to retry
- Ollama starts but API not reachable → retry 3 times with 2s delay,
  then show error with retry button

---

### Step 4 — Model Download
**What the user sees:**
> "Downloading Qwen2.5-Coder 7B...
> 2.3 GB of 4.7 GB (48%) — about 4 minutes remaining"
> *(progress bar with percentage and time estimate)*

Once done:
> "Chat model ready. ✓"
> "Downloading Qwen2.5-Coder 1.5B...
> 0.8 GB of 1 GB (80%)"
> "Autocomplete model ready. ✓"

**What happens in the background:**
- Call `ollama pull <model>` for each model via child process
- Parse stdout to extract download progress and update the UI in real time
- Models are stored by Ollama in `~/.ollama/models/` — we do not manage
  this directory directly
- Write model names to `config.json` once confirmed downloaded

**Error states:**
- Download interrupted (no internet mid-download) → show error, offer
  retry button. Ollama handles resuming partial downloads natively.
- Disk space runs out mid-download → show error, explain how much space
  is needed, stop.
- User closes VS Code mid-download → Ollama continues downloading in the
  background. On next VS Code open, detect partial state and resume from
  where the UI left off.

---

### Step 5 — Codebase Indexing
**What the user sees:**
> "Indexing your codebase for context-aware chat...
> 47 of 312 files indexed"
> *(progress bar)*
> "Codebase indexed. ✓"

**What happens in the background:**
- Walk the current workspace directory recursively
- Skip: `node_modules`, `.git`, `dist`, `build`, `__pycache__`,
  binary files, files > 500KB, files matching `.gitignore`
- For each code file: chunk it into overlapping segments, generate
  embeddings using a small local embedding model, store in LanceDB
- Embedding model used: `nomic-embed-text` via Ollama (pulled silently
  before this step as part of Step 4)
- Write index to `~/.vscode/extensions/localpilot/index/<workspace-hash>/`

**Performance target:** Index a 300-file codebase in under 60 seconds
on Tier 2 hardware.

**Error states:**
- Workspace has no code files → skip indexing, note this in UI, chat
  will work without codebase context
- Indexing fails partway → partial index is still usable, log the
  failure, do not block the user

---

### Step 6 — Ready
**What the user sees:**
> "LocalPilot is ready. ✓
>
> Try it:
> • Type some code and pause — autocomplete will appear
> • Ask a question in this chat panel
> • Type @codebase before your question to search your project
>
> Everything runs on your machine. Nothing is ever sent anywhere."

A single "Start Coding" button that dismisses the onboarding view and
shows the normal chat panel.

**What happens in the background:**
- Set `onboardingComplete: true` in `config.json`
- Register the InlineCompletionItemProvider
- The extension is now fully active

---

## Resuming Interrupted Onboarding

If VS Code is closed mid-onboarding, on next open:
- Read `config.json` to determine last completed step
- Resume from the last incomplete step
- Do not restart from Step 0
- Show a brief message: "Resuming setup from where we left off..."

---

## Re-running Onboarding

Available via command palette: `LocalPilot: Reset and Re-run Setup`

Use cases:
- User gets a new machine
- User wants to switch to a different model manually (post-v1)
- Something broke and they want a clean start

This deletes `config.json` and the LanceDB index, then runs onboarding
from Step 0. It does NOT delete Ollama or the downloaded models (those
live in `~/.ollama/` and are large — deleting them without asking would
be hostile UX).

---

## What Onboarding Does NOT Do

- Ask the user any questions
- Show any settings or configuration options
- Require the user to have any prior knowledge
- Make any network calls except to download Ollama and the models
- Store any information outside the local machine
