import type { Tier } from "./types";

// ----------------------------------------------------------------------------
// Ollama
// ----------------------------------------------------------------------------

// Default to 127.0.0.1 rather than "localhost". Ollama listens on 127.0.0.1,
// and Node's fetch may resolve "localhost" to ::1 first, causing spurious
// ECONNREFUSED errors. This is still localhost — the privacy invariant
// (no off-machine calls) is unchanged. Configurable via OllamaService.baseUrl
// so a post-v1 observability proxy can sit in front (DECISIONS 011).
export const OLLAMA_DEFAULT_BASE_URL = "http://127.0.0.1:11434";

// Known macOS install locations. Homebrew (Apple Silicon) first.
export const OLLAMA_BINARY_PATHS = [
  "/opt/homebrew/bin/ollama",
  "/usr/local/bin/ollama",
];

// Official install script (ONBOARDING_FLOW.md Step 3). Downloading Ollama is a
// sanctioned network exception to the all-local rule.
export const OLLAMA_INSTALL_SCRIPT_URL = "https://ollama.com/install.sh";

// ----------------------------------------------------------------------------
// Hardware tiers (HARDWARE_PROFILES.md)
// ----------------------------------------------------------------------------

// RAM thresholds in GiB. Mapping:
//   < 16        -> Tier 1
//   16 .. < 24  -> Tier 2
//   24 .. 36    -> Tier 3   (36GB maps to Tier 3 — DECISIONS 012)
//   > 36        -> Tier 4
export const TIER_2_MIN_GB = 16;
export const TIER_3_MIN_GB = 24;
export const TIER_3_MAX_GB = 36;

/** Safe fallback when hardware detection fails entirely. */
export const DEFAULT_TIER: Tier = 2;

/** Metal GPU acceleration requires macOS 13 (Ventura) or later. */
export const MIN_MACOS_MAJOR_FOR_METAL = 13;

/** Embedding model used at every tier (DECISIONS 006). */
export const EMBEDDING_MODEL = "nomic-embed-text";

/** Chat + autocomplete model per tier (HARDWARE_PROFILES.md). */
export const TIER_MODELS: Record<Tier, { chat: string; autocomplete: string }> =
  {
    1: { chat: "qwen2.5-coder:1.5b", autocomplete: "qwen2.5-coder:1.5b" },
    2: { chat: "qwen2.5-coder:7b", autocomplete: "qwen2.5-coder:1.5b" },
    3: { chat: "qwen2.5-coder:14b", autocomplete: "qwen2.5-coder:3b" },
    4: { chat: "qwen2.5-coder:32b", autocomplete: "qwen2.5-coder:3b" },
  };

// Minimum free disk (GiB) per tier: model download size plus working headroom.
// Tier 4's 30GB floor is specified in HARDWARE_PROFILES.md ("verify 30GB+ free
// ... otherwise fall back to Tier 3"). If a tier's floor isn't met, detect()
// steps down one tier at a time.
export const TIER_REQUIRED_DISK_GB: Record<Tier, number> = {
  1: 2,
  2: 8,
  3: 14,
  4: 30,
};

// ----------------------------------------------------------------------------
// Network timeouts / retries
// ----------------------------------------------------------------------------

/** Liveness ping to /api/tags. */
export const OLLAMA_PING_TIMEOUT_MS = 2000;

/** Default timeout for chat/generate/embeddings requests. */
export const OLLAMA_REQUEST_TIMEOUT_MS = 30000;

/** After `ollama serve`, poll the API this many times before giving up. */
export const OLLAMA_START_RETRIES = 3;
export const OLLAMA_START_RETRY_DELAY_MS = 2000;

// `ollama pull` can exit non-zero on a transient network error even though the
// server retries and the model completes. We re-attempt the pull a few times;
// Ollama resumes partial downloads natively (ONBOARDING_FLOW.md), so retries
// are cheap.
export const OLLAMA_PULL_MAX_ATTEMPTS = 3;
export const OLLAMA_PULL_RETRY_DELAY_MS = 2000;
