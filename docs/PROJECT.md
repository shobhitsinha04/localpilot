# PROJECT.md

## What Is This?

A VS Code extension that brings Cursor-like AI coding features — inline code 
generation, codebase chat, tab autocomplete — running entirely on your local 
machine. No internet connection required. No data ever leaves your computer.

## The Problem

Cloud-based AI coding assistants like Cursor and GitHub Copilot are genuinely 
useful, but every keystroke gets sent to an external server. For personal 
projects that's an inconvenience. For companies working with proprietary code, 
internal architecture, or sensitive business logic, it's a real risk. Teams 
either ban these tools entirely or use them and hope for the best.

The tools that do run locally today (like Continue.dev) require meaningful 
technical setup — picking models, editing config files, understanding how LLMs 
work. Most developers won't do that, and shouldn't have to.

## The Solution

An extension that is completely zero-config. You install it, it detects your 
hardware, automatically downloads the right AI model for your machine, indexes 
your codebase, and starts working. The user never has to know what Ollama is, 
what a quantized model is, or what RAG means.

## Who Is This For?

**Primary user:** Developers who want AI coding assistance but either can't or 
won't send their code to external servers. This includes:
- Engineers at companies with strict data policies
- Developers working on proprietary or sensitive codebases
- Privacy-conscious individual developers

**Secondary user:** Developers in low-connectivity or air-gapped environments 
who need AI assistance without internet dependency.

## What This Is Not

- This is not trying to beat Cursor on raw AI quality. Local models are not 
  as capable as GPT-4 or Claude. The tradeoff is privacy and control over 
  peak performance.
- This is not an IDE. It is a VS Code extension. We are not building an editor.
- This is not a model training or fine-tuning tool.

## What Success Looks Like

### v1 (MVP)
- A developer can install the extension and have it fully working within 
  5 minutes with zero manual configuration
- Inline code completions work
- A chat panel exists where users can ask questions about their codebase
- The correct model is automatically selected and downloaded based on hardware
- Nothing leaves the machine

### v2 (Post-MVP)
- Improved codebase indexing for larger projects
- Support for multiple models the user can switch between
- Performance improvements based on real usage data
- Potentially: team-level features (shared configs, model servers)

## What Done Means For v1

A person with no knowledge of LLMs installs the extension on a fresh machine, 
opens a code project, and within 5 minutes has working inline completions and 
codebase chat — without touching a single config file or reading any 
documentation.

## Core Principles

1. **Zero config** — every decision the user would have to make, we make for them
2. **Privacy absolute** — no telemetry, no external calls, no exceptions
3. **Honest about tradeoffs** — we don't pretend local models match GPT-4, 
   we make the privacy/quality tradeoff clear
4. **Execution over invention** — the tech exists, the job is to assemble it 
   well and make it feel polished

## Project Status

Early stage. Two-person team. Currently in specification and architecture phase 
before any code is written.