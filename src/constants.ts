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

// ----------------------------------------------------------------------------
// Codebase indexing (PHASES.md Phase 2 / DATA_FLOW.md §5–6)
// ----------------------------------------------------------------------------

/** Chunk window size and overlap, in lines (DATA_FLOW.md §5). */
export const CHUNK_SIZE_LINES = 150;
export const CHUNK_OVERLAP_LINES = 20;

/** Files larger than this are skipped during indexing (DATA_FLOW.md §5). */
export const MAX_INDEXABLE_FILE_BYTES = 500 * 1024;

/** Bytes sniffed from the head of a file for a null-byte binary check. */
export const NULL_BYTE_SNIFF_BYTES = 8192;

/**
 * Files are embedded in batches of this many — concurrent enough to be fast,
 * bounded enough not to overwhelm Ollama (DATA_FLOW.md §5 "batches of 5").
 */
export const INDEX_FILE_BATCH_SIZE = 5;

/**
 * Max characters sent to the embedding model per chunk. nomic-embed-text has a
 * ~2048-token context; a dense 150-line chunk can exceed it and return HTTP 500
 * ("input length exceeds the context length"). We embed a bounded prefix while
 * still storing the full chunk text for later prompt assembly. Builder decision
 * (found via the live indexing harness) — keeps DATA_FLOW's 150-line chunk
 * geometry intact for citations. 4000 chars sits safely under the model's limit
 * for even dense code (empirically ~4500 chars is the breaking point).
 */
export const EMBED_MAX_CHARS = 4000;

/** Vector search returns this many candidates before reranking (DATA_FLOW §4). */
export const SEARCH_TOP_K = 20;
/** Rerank narrows candidates down to this many chunks (DATA_FLOW §4). */
export const RERANK_TOP_K = 8;

/** Rerank score weights: 0.7×similarity + 0.3×recency (DATA_FLOW.md §4). */
export const RERANK_SIMILARITY_WEIGHT = 0.7;
export const RERANK_RECENCY_WEIGHT = 0.3;

/**
 * Half-life for the recency component of the rerank score. A file edited this
 * long ago scores 0.5; the score decays exponentially with age. "Recency" is
 * unspecified in DATA_FLOW.md — this exponential-decay reading is a Builder
 * decision (default 30 days), reversible without touching call sites.
 */
export const RECENCY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

/** Directories never descended into during indexing (DATA_FLOW.md §5). */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "__pycache__",
]);

/** Extensions treated as binary (skipped) without a content sniff. */
export const BINARY_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  // images
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".ico",
  ".webp",
  ".tiff",
  ".svg",
  // fonts
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  // archives
  ".zip",
  ".gz",
  ".tar",
  ".tgz",
  ".rar",
  ".7z",
  ".bz2",
  ".xz",
  // media
  ".mp3",
  ".mp4",
  ".mov",
  ".avi",
  ".mkv",
  ".wav",
  ".flac",
  ".webm",
  // documents / binaries
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".o",
  ".a",
  ".class",
  ".wasm",
  ".node",
  ".pyc",
  ".pdb",
  // data blobs
  ".lock",
  ".lockb",
  ".db",
  ".sqlite",
  ".sqlite3",
]);

// ----------------------------------------------------------------------------
// Sidebar chat (PHASES.md Phase 3 / FEATURES.md §3 / DATA_FLOW.md §3)
// ----------------------------------------------------------------------------

/** System prompt for sidebar chat without @codebase (DATA_FLOW.md §3). */
export const CHAT_SYSTEM_PROMPT =
  "You are a coding assistant. You have access to the user's current file. " +
  "Answer concisely and accurately.";

/** Chat sampling options (DATA_FLOW.md §3: temperature 0.7, top_p 0.95). */
export const CHAT_TEMPERATURE = 0.7;
export const CHAT_TOP_P = 0.95;

/**
 * The active file's contents are injected into the prompt only when the file is
 * at most this many lines (FEATURES.md §3 "if under 500 lines").
 */
export const MAX_CONTEXT_FILE_LINES = 500;

/**
 * History trimming for what is *sent to the model* (DATA_FLOW.md "Context
 * Window Management": keep the last ~10 exchanges). Counts individual messages,
 * so 20 ≈ 10 user+assistant exchanges. The full history always stays visible in
 * the UI; only the prompt is trimmed, oldest-first.
 */
export const MAX_HISTORY_MESSAGES = 20;

/**
 * Time-to-first-token budget for a chat request. Unlike completions, a chat
 * response can legitimately stream for a long time, so this aborts only when no
 * response has *started*; once tokens flow, streaming continues until done or
 * the user presses Stop (FEATURES.md §3 timeout state).
 */
export const CHAT_FIRST_TOKEN_TIMEOUT_MS = 30_000;

// ----------------------------------------------------------------------------
// Inline completions (PHASES.md Phase 4 / DATA_FLOW.md §1)
// ----------------------------------------------------------------------------

/**
 * Idle time after the last keystroke before a completion is requested. Keeps us
 * from firing (and cancelling) a request on every character while typing.
 */
export const COMPLETION_DEBOUNCE_MS = 600;

/**
 * Hard budget for a single completion request. A suggestion that doesn't arrive
 * by then is aborted and nothing renders (DATA_FLOW.md §1 — no error surfaced).
 *
 * DATA_FLOW.md specifies 3s, but a cold model load is ~2.7s and a 3s budget
 * aborts it, making autocomplete look broken (the warm path is ~0.3s). Set to 5s
 * to cover a cold load with headroom while keeping the warm path well under the
 * 2s DoD; pre-warm + COMPLETION_KEEP_ALIVE keep the model warm in practice. The
 * deviation from spec is recorded in DECISIONS.md (013); per-request latency
 * prints to the Output channel ("[completion] served in N ms").
 */
export const COMPLETION_TIMEOUT_MS = 5_000;

/** Lines of context taken above / below the cursor for the FIM prompt. */
export const COMPLETION_PREFIX_LINES = 20;
export const COMPLETION_SUFFIX_LINES = 10;

/**
 * Completion sampling (DATA_FLOW.md §1). Low temperature for deterministic,
 * conservative code; `stop` ends the suggestion at a blank line so a completion
 * can span a few lines without running away.
 */
export const COMPLETION_TEMPERATURE = 0.1;
export const COMPLETION_TOP_P = 0.95;
export const COMPLETION_STOP = ["\n\n"];

/**
 * How long Ollama keeps the autocomplete model resident between requests.
 * Ollama unloads after 5 min idle by default; reloading costs ~2.5s (a cold
 * model load), which is the dominant latency for inline completion. Holding it
 * for 30 min keeps a typing session snappy at the cost of ~1GB RAM.
 */
export const COMPLETION_KEEP_ALIVE = "30m";

/**
 * Language IDs that get inline completions. A curated allowlist of code
 * languages — markdown/JSON/plaintext/etc. are excluded because FIM completion
 * there is noise more than help (Phase 4 scope decision).
 */
export const COMPLETION_LANGUAGES: readonly string[] = [
  "typescript",
  "typescriptreact",
  "javascript",
  "javascriptreact",
  "python",
  "go",
  "rust",
  "java",
  "c",
  "cpp",
  "csharp",
  "ruby",
  "php",
  "swift",
  "kotlin",
  "scala",
  "shellscript",
  "lua",
  "html",
  "css",
  "scss",
  "vue",
  "svelte",
  "sql",
];

// ----------------------------------------------------------------------------
// CMD+K inline editing (PHASES.md Phase 5 / DATA_FLOW.md §2)
// ----------------------------------------------------------------------------

/**
 * System prompt for a CMD+K rewrite (DATA_FLOW.md §2). The model must return
 * only the rewritten code — any prose would be inserted into the file verbatim.
 */
export const EDIT_SYSTEM_PROMPT =
  "Rewrite the selected code according to the instruction. " +
  "Return only the rewritten code, no explanation, no markdown fences.";

/** Edit sampling (DATA_FLOW.md §2). Low temperature for faithful rewrites. */
export const EDIT_TEMPERATURE = 0.2;
export const EDIT_TOP_P = 0.95;

/** Lines of surrounding context included above and below the selection. */
export const EDIT_CONTEXT_LINES = 10;
