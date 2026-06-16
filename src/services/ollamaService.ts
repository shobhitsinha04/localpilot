import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";

import {
  CHAT_FIRST_TOKEN_TIMEOUT_MS,
  OLLAMA_BINARY_PATHS,
  OLLAMA_DEFAULT_BASE_URL,
  OLLAMA_INSTALL_SCRIPT_URL,
  OLLAMA_PING_TIMEOUT_MS,
  OLLAMA_PULL_MAX_ATTEMPTS,
  OLLAMA_PULL_RETRY_DELAY_MS,
  OLLAMA_REQUEST_TIMEOUT_MS,
  OLLAMA_START_RETRIES,
  OLLAMA_START_RETRY_DELAY_MS,
} from "../constants";
import type {
  ChatMessage,
  Logger,
  OllamaRequestOptions,
  PullProgress,
} from "../types";

/** Error type for any Ollama interaction failure. */
export class OllamaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OllamaError";
  }
}

// Shape of the NDJSON objects Ollama streams from /api/chat and /api/generate.
interface OllamaStreamChunk {
  message?: { content?: string };
  response?: string;
  done?: boolean;
  error?: string;
}

// ----------------------------------------------------------------------------
// Pure parsers (unit-tested directly)
// ----------------------------------------------------------------------------

/**
 * Parse one line of `ollama pull` output into a progress event, or null if the
 * line carries no useful status. Ollama emits lines like:
 *   "pulling manifest"
 *   "pulling 8eeb52dfb3bb... 47% ▕███   ▏ 2.2 GB/4.7 GB"
 *   "success"
 */
export function parsePullProgressLine(line: string): PullProgress | null {
  const text = line.trim();
  if (text.length === 0) return null;

  const percentMatch = text.match(/(\d{1,3})%/);
  const percent = percentMatch
    ? Math.min(100, Number.parseInt(percentMatch[1], 10))
    : undefined;

  // Status is the leading words before any percentage / progress bar.
  const status = text.split(/\s+\d{1,3}%/)[0].trim() || text;
  return { status, percent };
}

/**
 * Parse one NDJSON line from a streaming response. `kind` selects the field:
 * /api/chat puts text in message.content, /api/generate in response.
 */
export function parseStreamLine(
  line: string,
  kind: "chat" | "generate",
): { token: string; done: boolean } {
  const chunk = JSON.parse(line) as OllamaStreamChunk;
  if (chunk.error) {
    throw new OllamaError(chunk.error);
  }
  const token =
    kind === "chat" ? (chunk.message?.content ?? "") : (chunk.response ?? "");
  return { token, done: chunk.done === true };
}

/**
 * Reduce captured `ollama pull` stderr (full of ANSI codes and redrawn
 * progress bars) to a short, human-meaningful error summary for logging.
 */
export function summariseStderr(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const noAnsi = raw.replace(/\x1B\[[0-9;?]*[A-Za-z]/g, "");
  const lines = noAnsi
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return "";
  const errorLine = [...lines].reverse().find((line) => /error/i.test(line));
  return (errorLine ?? lines[lines.length - 1]).slice(0, 200);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ----------------------------------------------------------------------------
// Service
// ----------------------------------------------------------------------------

export class OllamaService {
  private readonly logger: Logger;
  private readonly baseUrl: string;
  /** The `ollama serve` process, if we started it (so we can stop it). */
  private serveProcess?: ChildProcess;

  constructor(opts: { logger: Logger; baseUrl?: string }) {
    this.logger = opts.logger;
    this.baseUrl = opts.baseUrl ?? OLLAMA_DEFAULT_BASE_URL;
  }

  /** True if the ollama binary exists at a known macOS path. */
  isInstalled(): boolean {
    return this.findBinary() !== null;
  }

  /** True if the Ollama API answers on the configured base URL. */
  async isRunning(): Promise<boolean> {
    try {
      const res = await this.fetchWithTimeout(
        `${this.baseUrl}/api/tags`,
        { method: "GET" },
        OLLAMA_PING_TIMEOUT_MS,
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Install Ollama via the official script (ONBOARDING_FLOW.md Step 3). */
  async install(): Promise<void> {
    this.logger.info("Installing Ollama via the official install script...");
    await this.runShell(`curl -fsSL ${OLLAMA_INSTALL_SCRIPT_URL} | sh`);
    if (!this.isInstalled()) {
      throw new OllamaError(
        "Ollama install script finished but the binary was not found.",
      );
    }
  }

  /** Start `ollama serve` as a background process and wait until it answers. */
  async start(): Promise<void> {
    if (await this.isRunning()) return;

    const binary = this.findBinary();
    if (!binary) {
      throw new OllamaError("Cannot start Ollama: binary not found.");
    }

    const child = spawn(binary, ["serve"], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", (err) =>
      this.logger.error("`ollama serve` process error", err),
    );
    child.unref();
    this.serveProcess = child;

    for (let attempt = 0; attempt < OLLAMA_START_RETRIES; attempt++) {
      await delay(OLLAMA_START_RETRY_DELAY_MS);
      if (await this.isRunning()) return;
    }
    throw new OllamaError(
      "Ollama was started but its API did not become reachable.",
    );
  }

  /**
   * Pull a model via `ollama pull`, parsing stdout/stderr for progress
   * (PHASES.md / ONBOARDING_FLOW.md).
   *
   * The CLI exit code is not a reliable success signal: a transient network
   * error mid-download (e.g. "context deadline exceeded") can make `ollama
   * pull` exit non-zero even though the server retries and the model
   * completes. So after each attempt we check whether the model is actually
   * present and, if not, retry — Ollama resumes partial downloads natively.
   */
  async pullModel(
    model: string,
    onProgress?: (progress: PullProgress) => void,
  ): Promise<void> {
    const binary = this.findBinary();
    if (!binary) {
      throw new OllamaError("Cannot pull model: Ollama binary not found.");
    }

    let lastError = "";
    for (let attempt = 1; attempt <= OLLAMA_PULL_MAX_ATTEMPTS; attempt++) {
      const { code, stderrTail } = await this.runPullOnce(
        binary,
        model,
        onProgress,
      );
      if (code === 0) return;

      // Non-zero exit: the model may still have completed after a server-side
      // retry, so treat presence as success.
      if (await this.hasModel(model)) {
        this.logger.warn(
          `\`ollama pull ${model}\` exited ${code}, but the model is present — treating as success.`,
        );
        return;
      }

      lastError = stderrTail;
      this.logger.warn(
        `Pull attempt ${attempt}/${OLLAMA_PULL_MAX_ATTEMPTS} for ${model} failed (exit ${code}). ${stderrTail}`,
      );
      if (attempt < OLLAMA_PULL_MAX_ATTEMPTS) {
        await delay(OLLAMA_PULL_RETRY_DELAY_MS);
      }
    }

    throw new OllamaError(
      `Failed to pull ${model} after ${OLLAMA_PULL_MAX_ATTEMPTS} attempts. ${lastError}`.trim(),
    );
  }

  /** Run one `ollama pull`, resolving with its exit code and a stderr tail. */
  private runPullOnce(
    binary: string,
    model: string,
    onProgress?: (progress: PullProgress) => void,
  ): Promise<{ code: number; stderrTail: string }> {
    return new Promise((resolve) => {
      const child = spawn(binary, ["pull", model]);
      let stderrBuffer = "";

      const handleProgress = (buf: Buffer): void => {
        // Ollama overwrites the progress line with carriage returns, so split
        // on both \r and \n to catch every update.
        for (const line of buf.toString().split(/[\r\n]+/)) {
          const progress = parsePullProgressLine(line);
          if (progress && onProgress) onProgress(progress);
        }
      };

      child.stdout?.on("data", handleProgress);
      child.stderr?.on("data", (buf: Buffer) => {
        handleProgress(buf);
        // Keep a bounded tail of stderr for diagnostics on failure.
        stderrBuffer = (stderrBuffer + buf.toString()).slice(-2000);
      });
      child.on("error", (err) => {
        stderrBuffer = `${stderrBuffer} ${String(err)}`.slice(-2000);
        resolve({ code: -1, stderrTail: summariseStderr(stderrBuffer) });
      });
      child.on("close", (code) => {
        resolve({
          code: code ?? -1,
          stderrTail: summariseStderr(stderrBuffer),
        });
      });
    });
  }

  /** True if `model` appears in Ollama's list of downloaded models. */
  async hasModel(model: string): Promise<boolean> {
    try {
      return (await this.listModelNames()).includes(model);
    } catch {
      return false;
    }
  }

  /** Names of all downloaded models (GET /api/tags). */
  async listModelNames(): Promise<string[]> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/api/tags`,
      { method: "GET" },
      OLLAMA_PING_TIMEOUT_MS,
    );
    if (!res.ok) {
      throw new OllamaError(
        `Ollama /api/tags returned ${res.status} ${res.statusText}`,
      );
    }
    const data = (await res.json()) as { models?: { name: string }[] };
    return (data.models ?? []).map((m) => m.name);
  }

  /**
   * Chat completion (POST /api/chat, streamed). Yields token strings as they
   * arrive. Prompt assembly belongs to the Prompt Engine — this method only
   * transports an already-assembled message array.
   *
   * Cancellation: pass an `AbortSignal` (e.g. from the chat UI's Stop button)
   * to end generation early — the generator simply stops yielding. Timeout:
   * unlike a one-shot completion, a chat reply can legitimately stream for a
   * long time, so the timeout is a *time-to-first-token* budget — it aborts
   * only if no response has begun. Once tokens flow, streaming continues until
   * `done` or the caller aborts.
   */
  async *chat(
    messages: ChatMessage[],
    model: string,
    options?: OllamaRequestOptions,
    signal?: AbortSignal,
  ): AsyncGenerator<string> {
    const controller = new AbortController();
    const abortFromCaller = (): void => controller.abort();
    if (signal) {
      if (signal.aborted) return;
      signal.addEventListener("abort", abortFromCaller, { once: true });
    }

    // First-token watchdog: aborts the request if headers never arrive. Cleared
    // as soon as the response starts, so it never cuts off an active stream.
    let timedOut = false;
    const firstTokenTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, CHAT_FIRST_TOKEN_TIMEOUT_MS);

    try {
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, messages, stream: true, options }),
          signal: controller.signal,
        });
      } catch (err) {
        if (timedOut) {
          throw new OllamaError(
            `Ollama did not start responding within ${CHAT_FIRST_TOKEN_TIMEOUT_MS}ms.`,
          );
        }
        if (signal?.aborted) return; // Stopped before the response began.
        throw err;
      } finally {
        clearTimeout(firstTokenTimer);
      }

      if (!res.ok || !res.body) {
        throw new OllamaError(
          `Ollama /api/chat returned ${res.status} ${res.statusText}`,
        );
      }

      try {
        yield* this.streamTokens(res.body, "chat");
      } catch (err) {
        // An abort mid-stream (Stop pressed) is normal termination, not an error.
        if (controller.signal.aborted) return;
        throw err;
      }
    } finally {
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  /**
   * Single-shot completion (POST /api/generate, not streamed). Sent with
   * `raw: true` so the prompt reaches the model verbatim — inline completion
   * relies on Qwen FIM tokens that Ollama would otherwise wrap in the instruct
   * chat template (validated in Phase 4).
   *
   * Cancellation: pass a `signal` (superseded by a newer keystroke) and/or a
   * short `timeoutMs`. Either firing aborts the request and resolves to "" —
   * for inline completion an abort means "no suggestion", not an error.
   */
  async complete(
    prompt: string,
    model: string,
    options?: OllamaRequestOptions,
    signal?: AbortSignal,
    timeoutMs: number = OLLAMA_REQUEST_TIMEOUT_MS,
    keepAlive?: string,
  ): Promise<string> {
    const controller = new AbortController();
    const abortFromCaller = (): void => controller.abort();
    if (signal) {
      if (signal.aborted) return "";
      signal.addEventListener("abort", abortFromCaller, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(`${this.baseUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          prompt,
          stream: false,
          raw: true,
          options,
          // Keep the model resident between requests so repeat completions don't
          // re-pay the cold-load cost (the dominant latency). Omitted → Ollama
          // default (5 min).
          ...(keepAlive ? { keep_alive: keepAlive } : {}),
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new OllamaError(
          `Ollama /api/generate returned ${res.status} ${res.statusText}`,
        );
      }
      const data = (await res.json()) as OllamaStreamChunk;
      return data.response ?? "";
    } catch (err) {
      // A timeout or a superseding keystroke aborts the request — normal for
      // inline completion, so report "no completion" rather than throwing.
      if (controller.signal.aborted) return "";
      throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  /**
   * Streaming completion (POST /api/generate, streamed) for CMD+K inline edits
   * (DATA_FLOW.md §2). Unlike `complete()` this is NOT `raw` — the instruct chat
   * model must apply its template so it follows the `system` rewrite instruction.
   * Yields tokens as they arrive; pass an `AbortSignal` (Esc / Reject) to stop —
   * an abort ends the generator quietly rather than throwing.
   */
  async *generateStream(
    prompt: string,
    model: string,
    options?: OllamaRequestOptions,
    signal?: AbortSignal,
    system?: string,
  ): AsyncGenerator<string> {
    const controller = new AbortController();
    const abortFromCaller = (): void => controller.abort();
    if (signal) {
      if (signal.aborted) return;
      signal.addEventListener("abort", abortFromCaller, { once: true });
    }

    try {
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            prompt,
            system,
            stream: true,
            options,
          }),
          signal: controller.signal,
        });
      } catch (err) {
        if (signal?.aborted) return; // Cancelled before the response began.
        throw err;
      }

      if (!res.ok || !res.body) {
        throw new OllamaError(
          `Ollama /api/generate returned ${res.status} ${res.statusText}`,
        );
      }

      try {
        yield* this.streamTokens(res.body, "generate");
      } catch (err) {
        if (controller.signal.aborted) return; // Cancelled mid-stream.
        throw err;
      }
    } finally {
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  /** Generate an embedding vector (POST /api/embeddings). */
  async embed(text: string, model: string): Promise<number[]> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/api/embeddings`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt: text }),
      },
      OLLAMA_REQUEST_TIMEOUT_MS,
    );
    if (!res.ok) {
      throw new OllamaError(
        `Ollama /api/embeddings returned ${res.status} ${res.statusText}`,
      );
    }
    const data = (await res.json()) as { embedding?: number[] };
    return data.embedding ?? [];
  }

  /** Stop the `ollama serve` process we started, if any. Called on deactivate. */
  stop(): void {
    if (this.serveProcess && !this.serveProcess.killed) {
      try {
        this.serveProcess.kill();
      } catch (err) {
        this.logger.warn(`Failed to stop ollama serve: ${String(err)}`);
      }
      this.serveProcess = undefined;
    }
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private findBinary(): string | null {
    for (const candidate of OLLAMA_BINARY_PATHS) {
      if (existsSync(candidate)) return candidate;
    }
    // Fall back to scanning PATH so a non-standard install location (e.g. a
    // custom Homebrew prefix) is still found after install().
    for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
      if (dir.length === 0) continue;
      const candidate = path.join(dir, "ollama");
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  private async *streamTokens(
    body: ReadableStream<Uint8Array>,
    kind: "chat" | "generate",
  ): AsyncGenerator<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line.length === 0) continue;
          const { token, done: streamDone } = parseStreamLine(line, kind);
          if (token) yield token;
          if (streamDone) return;
        }
      }
      const tail = buffer.trim();
      if (tail.length > 0) {
        const { token } = parseStreamLine(tail, kind);
        if (token) yield token;
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private async runShell(command: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("/bin/sh", ["-c", command], { stdio: "ignore" });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else
          reject(new OllamaError(`Command failed (exit ${code}): ${command}`));
      });
    });
  }
}
