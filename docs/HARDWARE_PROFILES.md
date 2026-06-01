# HARDWARE_PROFILES.md

## Overview

Hardware detection runs once on first activation. The result maps the user's
machine to a tier, which determines which model gets downloaded automatically.
The user never sees this logic — they just see "setting up your model..." and
it works.

This file is macOS / Apple Silicon only for v1.

---

## Why Apple Silicon Is Special

On Apple Silicon, RAM is unified — the CPU and GPU share the same memory pool.
This means a MacBook Pro with 36GB RAM can run a 30B parameter model comfortably,
whereas a PC with a 24GB GPU would be limited to 13-14B models. This is a major
advantage for local LLM inference and why targeting macOS first makes sense.

The practical rule: available RAM determines which model tier is viable.
OS and background apps typically consume 4-6GB, so always subtract that from
available RAM when calculating what the model can use.

---

## Detection Logic

The Hardware Detector reads the following at activation:

```
1. Total unified memory (via sysctl hw.memsize)
2. Apple chip generation (M1 / M2 / M3 / M4) via sysctl machdep.cpu.brand_string
3. Chip variant (base / Pro / Max / Ultra) — determines memory bandwidth
4. Available disk space (model download requires headroom)
5. macOS version (Metal acceleration requires macOS 13 Ventura or later)
```

Detection takes < 1 second. All via native macOS system calls, no external
dependencies.

---

## Hardware Tiers

### Tier 1 — Entry (8GB RAM)
**Machines:** MacBook Air M1/M2/M3/M4 base configs (older, pre-2024)

**Reality check:** 8GB is tight. OS takes 4-6GB, leaving ~2-3GB for the model.
Only the smallest quantized models fit. Completions will be noticeably slower
and quality will be lower. We are honest about this in the UI.

**Chat model:** `qwen2.5-coder:1.5b` (Q4_K_M, ~1GB)
**Autocomplete model:** `qwen2.5-coder:1.5b` (same model, alternated)
**Expected speed:** ~15-20 tokens/sec
**Download size:** ~1GB

**Behaviour:** On first chat, show a one-time notice:
> "Your machine has 8GB RAM. We've selected the most efficient model available.
> Response quality is functional but limited compared to larger models."

---

### Tier 2 — Standard (16GB RAM)
**Machines:** MacBook Air M1/M2/M3/M4 (most common config as of 2024+),
MacBook Pro M1/M2/M3 base

**This is the primary target user.** 16GB is the current default for most
new Macs. The 7B model runs well here with good speed and quality for everyday
coding tasks: single-function generation, explanations, basic debugging.

**Chat model:** `qwen2.5-coder:7b` (Q4_K_M, ~4.7GB)
**Autocomplete model:** `qwen2.5-coder:1.5b` (Q4_K_M, ~1GB, faster for completions)
**Expected speed:** ~35 tokens/sec
**Download size:** ~6GB total

**Note:** We use a smaller model for autocomplete (1.5b) even on 16GB machines
because autocomplete needs to be fast — the user is waiting in real time.
The 7B is reserved for chat where a few extra seconds is acceptable.

---

### Tier 3 — Performance (24GB–36GB RAM)
**Machines:** MacBook Pro M2/M3/M4 Pro, MacBook Air M2/M3 maxed out,
Mac Mini M2 Pro/M4 Pro

**Significant quality jump.** The 14B model handles multi-file reasoning,
complex debugging, and longer context windows meaningfully better than 7B.
This is the tier where the product feels genuinely capable.

**Chat model:** `qwen2.5-coder:14b` (Q4_K_M, ~9GB)
**Autocomplete model:** `qwen2.5-coder:3b` (Q4_K_M, ~2GB)
**Expected speed:** ~25-30 tokens/sec (chat), ~40 tokens/sec (autocomplete)
**Download size:** ~11GB total

---

### Tier 4 — High-End (36GB+ RAM)
**Machines:** MacBook Pro M2/M3/M4 Max, Mac Studio M2/M3/M4,
Mac Pro, any machine with 48GB/64GB/96GB/128GB

**The 32B model is competitive with GPT-4o on coding benchmarks.**
This is where the privacy/quality tradeoff largely disappears for most
coding tasks. Users on this tier get a genuinely excellent experience.

**Chat model:** `qwen2.5-coder:32b` (Q4_K_M, ~22GB)
**Autocomplete model:** `qwen2.5-coder:3b` (Q4_K_M, ~2GB)
**Expected speed:** ~20 tokens/sec (chat), ~45 tokens/sec (autocomplete)
**Download size:** ~24GB total

**Disk check:** Before downloading, verify 30GB+ free disk space. If not
available, warn the user and fall back to Tier 3.

---

## Tier Summary Table

| Tier | RAM    | Chat Model           | Autocomplete Model   | Total Download |
|------|--------|----------------------|----------------------|----------------|
| 1    | 8GB    | qwen2.5-coder:1.5b   | qwen2.5-coder:1.5b   | ~1GB           |
| 2    | 16GB   | qwen2.5-coder:7b     | qwen2.5-coder:1.5b   | ~6GB           |
| 3    | 24-36GB| qwen2.5-coder:14b    | qwen2.5-coder:3b     | ~11GB          |
| 4    | 36GB+  | qwen2.5-coder:32b    | qwen2.5-coder:3b     | ~24GB          |

---

## Why Qwen2.5-Coder Across All Tiers

- Available in every size (1.5b, 3b, 7b, 14b, 32b) — consistent family
  across all tiers, predictable behaviour
- Best-in-class for coding tasks at every parameter count
- The 32B model benchmarks competitively with GPT-4o on code repair
- Apache 2.0 license — no legal issues for users or us
- Well supported by Ollama with optimised macOS Metal builds
- Strong multi-language support (92+ programming languages)

---

## Edge Cases

**Insufficient disk space for assigned tier:**
Fall back to the next tier down. Notify the user:
> "Not enough disk space for the recommended model. We've selected a
> smaller model instead. Free up space and reinstall to upgrade."

**macOS version below Ventura (13):**
Metal GPU acceleration is unavailable. Models will run on CPU only and
will be significantly slower. Show a warning:
> "For best performance, upgrade to macOS Ventura or later. Your current
> setup will work but may be slow."

**Detection fails entirely:**
Default to Tier 2 (7B model). Safe middle ground that works on most
machines without risk of running out of memory.

**User wants to override:**
Post-v1 feature. In v1, the extension picks the model and the user cannot
change it. We keep this simple intentionally.

---

## What We Do NOT Detect in v1

- Intel Macs: not supported in v1. If detected, show a clear message
  that v1 is Apple Silicon only and link to a waitlist or GitHub issue.
- External GPUs: ignored in v1.
- Available RAM at runtime (only total RAM at install): a future improvement
  would check free RAM dynamically, but for v1 total RAM is sufficient.
