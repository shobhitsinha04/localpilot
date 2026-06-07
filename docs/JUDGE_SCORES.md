# JUDGE_SCORES.md

Structured log of every Judge Agent review (LLM-as-a-judge, see AGENT_JUDGE.md).
One row per review **run** — a phase may be reviewed more than once (a BLOCKED
run, then an APPROVED run after fixes). Scores are 1–5 per dimension; any
dimension below 3 blocks the phase. Newest phase at the top.

Dimensions: **Spec** (Spec Compliance) · **Arch** (Architecture) ·
**Err** (Error Handling) · **Priv** (Privacy) · **Qual** (Code Quality) ·
**Test** (Test Coverage).

<!-- Maintained alongside CHANGELOG.md at each phase close. Append a run row
     after every Judge review; do not edit historical rows. -->

---

## Phase 2 — Codebase Indexing

| Run | Date | Spec | Arch | Err | Priv | Qual | Test | Total | Status |
|-----|------|------|------|-----|------|------|------|-------|--------|
| 1 | 2026-06-07 | 5 | 5 | 4 | 5 | 4 | 5 | 28 | APPROVED |

**Run 1 notes:** Approved cold at 28/30, all dimensions ≥4, no Critical
findings. Two Minor findings were **fixed before close** (not deferred):
(a) `updateFile`/`deleteFile` acquired the `proper-lockfile` lock before the
index dir existed (default `realpath:true` → ENOENT), so a watcher event before
the first full index would silently no-op — fixed by ensuring the dir in
`acquireLock()`; (b) `isIndexablePath` used a raw `startsWith` prefix check
(`/project` matched `/project-2`) — replaced with a `path.relative`
containment check. Observations (cosine-vs-L2 similarity, `EMBED_MAX_CHARS`
truncation, gitignore-not-rechecked-on-update, 30-day recency half-life) were
accepted as documented Builder decisions, no action.

---

## Phase 1 — Ollama Integration + Hardware Detection

| Run | Date | Spec | Arch | Err | Priv | Qual | Test | Total | Status |
|-----|------|------|------|-----|------|------|------|-------|--------|
| 1 | 2026-06-06 | — | — | — | — | — | 1 | <27 | BLOCKED |
| 2 | 2026-06-06 | — | — | — | — | — | — | 27 | APPROVED |

**Run 1 notes:** False-negative block — the Judge session was not given the
`test/` directory, so Test Coverage scored 1/5 ("zero tests") despite 53 tests
being committed. Lesson now standing: always hand the Judge the full tree
(`src/ + test/ + docs/`) at HEAD.

**Run 2 notes:** Approved at 27/30 with tests in context. Per-dimension
breakdown was not captured in a structured form at the time (only the 27/30
total is recorded in CHANGELOG.md); dimensions shown as "—". This file exists so
that, from Phase 2 onward, every run's full breakdown is preserved here.
