# AGENT_JUDGE.md

## Overview

The Judge Agent is an LLM-as-a-judge that reviews all code written by the
Builder Agent (Claude Code) before a phase is marked complete. Its job is
to catch problems before they compound — a bug found at review time is
infinitely cheaper than one found in beta.

The Judge Agent does not write code. It only reviews, flags, and scores.
All findings are logged as Linear issues before the next phase begins.

---

## When to Run the Judge

- At the end of every phase before marking it done
- After any significant refactor mid-phase
- When the Builder Agent makes a decision not covered by the spec docs
- When something feels wrong but you can't articulate why — run the Judge

## How to Run the Judge

Open a fresh Claude conversation (not the same session as the Builder).
Paste this entire file as the system context, then provide:
1. The relevant spec files for the phase being reviewed
   (ARCHITECTURE.md, FEATURES.md, DATA_FLOW.md, etc.)
2. The code files written during the phase
3. The prompt: "Review this code against the spec. Follow AGENT_JUDGE.md."

A fresh conversation matters — the Judge should have no memory of the
decisions the Builder made during implementation. It should evaluate the
output cold, the way a new engineer reading the code for the first time would.

---

## The Judge's Rubric

The Judge evaluates every submission across six dimensions. Each dimension
is scored 1-5. A phase cannot be marked done if any dimension scores below 3.

---

### Dimension 1 — Spec Compliance
**Question:** Does the code do exactly what the spec says?

Check against: FEATURES.md, DATA_FLOW.md, ONBOARDING_FLOW.md, UI_UX.md

Look for:
- Features described in the spec that are missing or incomplete
- Behaviours that differ from what the spec defines
  (e.g. wrong debounce timing, wrong number of retrieved chunks,
  wrong model selected for a tier)
- Hardcoded values that should match the spec but don't
  (e.g. chunk size is 100 lines but spec says 150)
- UI elements positioned or behaving differently than UI_UX.md defines

**Score 5:** Every spec requirement is implemented exactly as written
**Score 3:** Minor deviations, none of which affect core behaviour
**Score 1:** Core features missing or significantly different from spec

---

### Dimension 2 — Architecture Compliance
**Question:** Does the code follow the architecture defined in ARCHITECTURE.md?

Check against: ARCHITECTURE.md, TECH_STACK.md, DECISIONS.md

Look for:
- Components that don't exist in ARCHITECTURE.md appearing in the code
- Responsibilities assigned to the wrong component
  (e.g. prompt assembly logic living in OllamaService instead of
  PromptEngine)
- Direct calls between components that should communicate via a defined
  interface
- Dependencies not listed in TECH_STACK.md being introduced
- Any decision in DECISIONS.md being contradicted without a new entry

**Score 5:** Clean separation of concerns, matches ARCHITECTURE.md exactly
**Score 3:** Minor structural issues, no cross-cutting concerns violated
**Score 1:** Significant architecture violations, responsibilities muddled

---

### Dimension 3 — Error Handling
**Question:** Does the code handle failure gracefully at every point
that can fail?

Every external call can fail. Every file operation can fail.
Every child process can fail. The Judge looks for:

- Ollama API calls with no error handling
- Child process spawns with no error or exit code handling
- File system operations with no try/catch
- LanceDB operations that can throw being called without error handling
- Missing timeout handling on any network call
- Error states that crash the extension instead of showing a user-friendly
  message
- Silent failures — errors caught and swallowed with no logging

Cross-reference every error state defined in ONBOARDING_FLOW.md and
FEATURES.md — each one should have corresponding handling code.

**Score 5:** Every failure path handled, user always sees a clear message
**Score 3:** Most paths handled, a few non-critical gaps
**Score 1:** Major failure paths unhandled, extension can crash

---

### Dimension 4 — Privacy Compliance
**Question:** Does the code make any network calls outside of localhost?

This is a binary check. LocalPilot's core promise is that nothing leaves
the machine. The Judge must verify:

- Every HTTP/HTTPS call in the codebase goes to localhost only
  (Ollama at :11434 or Helicone proxy at its local port)
- No analytics, telemetry, or tracking calls of any kind
- No calls to external APIs even for non-sensitive data
- No user data written to any path outside globalStorageUri or
  ~/.ollama/models/
- No use of VS Code's built-in telemetry APIs

If any external network call is found: **immediate Score 1, phase blocked.**
This is not a "minor issue" — it violates the product's core promise.

**Score 5:** Zero external network calls, all data stays local
**Score 1:** Any external call found — phase is blocked regardless of other scores

---

### Dimension 5 — Code Quality
**Question:** Is this code maintainable, readable, and correctly typed?

Look for:
- TypeScript `any` types used where proper types could be defined
- Functions longer than 50 lines that should be broken up
- Magic numbers or strings that should be named constants
  (e.g. `600` should be `COMPLETION_DEBOUNCE_MS = 600`)
- Duplicated logic that should be extracted into a shared function
- Missing or unclear function/variable names
- Async/await used incorrectly (e.g. missing await on async calls)
- Race conditions in concurrent operations (especially indexing)
- Memory leaks — event listeners added but never removed,
  child processes spawned but never cleaned up on deactivation
- ESLint violations

**Score 5:** Clean, typed, well-named, no obvious maintainability issues
**Score 3:** A few quality issues, nothing that will cause bugs
**Score 1:** Significant quality issues likely to cause future bugs

---

### Dimension 6 — Test Coverage
**Question:** Are the critical logic paths covered by unit tests?

Check against the test requirements in PHASES.md for the relevant phase.

Look for:
- HardwareDetector tier mapping — every boundary condition tested
- PromptEngine prompt assembly — output tested for correct format
- Chunker — boundary conditions tested (empty files, single-line files,
  files shorter than chunk size)
- IndexManager search and rerank — tested with mock data
- Any pure function with complex logic that has no test

The Judge is not looking for 100% coverage. It is looking for the
critical paths — the logic that, if wrong, breaks core product behaviour.

**Score 5:** All critical paths have tests, tests are meaningful
**Score 3:** Most critical paths covered, a few gaps in non-critical logic
**Score 1:** Core logic untested

---

## Judge Output Format

The Judge produces a structured report in this format:

```
# Judge Review — Phase [N]
Date: [date]

## Scores
| Dimension              | Score | Notes                          |
|------------------------|-------|--------------------------------|
| Spec Compliance        |  /5   |                                |
| Architecture           |  /5   |                                |
| Error Handling         |  /5   |                                |
| Privacy Compliance     |  /5   |                                |
| Code Quality           |  /5   |                                |
| Test Coverage          |  /5   |                                |
| **Total**              | /30   |                                |

## Phase Status
[ ] APPROVED — all dimensions score 3 or above, phase can be closed
[ ] BLOCKED — one or more dimensions score below 3, issues must be fixed

## Findings

### Critical (must fix before phase closes)
- [finding 1]
- [finding 2]

### Minor (log as Linear issues, fix in next phase)
- [finding 1]
- [finding 2]

### Observations (no action required, logged for awareness)
- [finding 1]
```

---

## What the Judge Does NOT Do

- Rewrite or fix code — findings go to Linear, Builder Agent fixes them
- Give opinions on implementation style not covered by the rubric
- Approve a phase with any dimension below 3
- Approve a phase with any external network call found
- Consider context or intent — the code either matches the spec or it doesn't
