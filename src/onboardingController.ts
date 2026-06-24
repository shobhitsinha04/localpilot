import { HardwareDetector, modelsForTier } from "./services/hardwareDetector";
import type { ConfigManager } from "./services/configManager";
import type { ContextService } from "./contextService";
import type { OllamaService } from "./services/ollamaService";
import type { Logger, ModelSet } from "./types";
import type { OnboardingActionId, OnboardingView } from "./webviewProtocol";

// Drives the first-run onboarding flow rendered in the chat webview (Phase 6
// WP2, ONBOARDING_FLOW.md, DECISIONS 017). `vscode`-coupled glue: it sequences
// the same operations the headless setup used (hardware → models → Ollama →
// pulls → index) but reports each as an OnboardingView the webview renders, and
// pauses at the user gates (Get Started, Download Models, Start Coding).

/** Total onboarding steps (0 Welcome … 6 Ready). */
const TOTAL_STEPS = 7;

/**
 * Rough remaining-time estimate from elapsed time and percent complete, for the
 * download progress screen. Pure (elapsed is passed in, not read from a clock)
 * so it is unit-tested directly. Returns undefined when there's nothing
 * meaningful to show (not started, or done).
 */
export function formatEta(
  elapsedMs: number,
  percent: number,
): string | undefined {
  if (percent <= 0 || percent >= 100) return undefined;
  const remainingMs = (elapsedMs / percent) * (100 - percent);
  const mins = Math.round(remainingMs / 60000);
  if (mins >= 1)
    return `about ${mins} minute${mins === 1 ? "" : "s"} remaining`;
  const secs = Math.max(5, Math.round(remainingMs / 1000));
  return `about ${secs}s remaining`;
}

/** Rough on-disk sizes for the download consent screen (ONBOARDING_FLOW.md). */
const MODEL_SIZES: Record<string, string> = {
  "qwen2.5-coder:1.5b": "~1 GB",
  "qwen2.5-coder:3b": "~2 GB",
  "qwen2.5-coder:7b": "~4.7 GB",
  "qwen2.5-coder:14b": "~9 GB",
  "qwen2.5-coder:32b": "~20 GB",
  "nomic-embed-text": "~0.3 GB",
};

export interface OnboardingDeps {
  ollama: OllamaService;
  config: ConfigManager;
  contextService: ContextService | undefined;
  logger: Logger;
  /** Send a screen to the webview. */
  post: (view: OnboardingView) => void;
  /** Register inline completions + the index watcher once setup completes. */
  finalize: () => Promise<void>;
  /** Swap the webview from onboarding to the normal chat UI. */
  showChat: () => void;
}

type Phase = "welcome" | "models" | "downloading" | "ready" | "running";

export class OnboardingController {
  private phase: Phase = "welcome";
  private models?: ModelSet;

  constructor(private readonly deps: OnboardingDeps) {}

  /** Show the welcome screen (called when the webview is ready, if not onboarded). */
  begin(): void {
    this.phase = "welcome";
    this.deps.post({
      step: 0,
      total: TOTAL_STEPS,
      title: "Welcome to LocalPilot",
      detail:
        "We'll set everything up for you — about 5–15 minutes, mostly the " +
        "one-time model download. After that it all runs offline, and nothing " +
        "you type ever leaves your machine.",
      mode: "prompt",
      actionId: "getStarted",
      actionLabel: "Get Started",
    });
  }

  /** Handle a button press from the webview. */
  async handleAction(id: OnboardingActionId): Promise<void> {
    if (id === "getStarted" && this.phase === "welcome") {
      await this.runDetectAndSelect();
    } else if (id === "downloadModels" && this.phase === "models") {
      await this.runDownloadAndIndex();
    } else if (id === "startCoding" && this.phase === "ready") {
      await this.finish();
    } else if (id === "retry") {
      await this.retry();
    }
  }

  // --- Steps ---------------------------------------------------------------

  /** Steps 1–2: hardware detection → model-selection consent screen. */
  private async runDetectAndSelect(): Promise<void> {
    this.phase = "running";
    try {
      this.info(
        1,
        "Detecting your hardware…",
        "Checking memory, disk, and chip.",
      );
      const hw = await new HardwareDetector(this.deps.logger).detect();
      if (!hw.supported) {
        this.error(
          1,
          "Unsupported hardware",
          hw.unsupportedReason ??
            "LocalPilot v1 supports Apple Silicon only. Intel support is coming.",
          false, // no retry — this is terminal
        );
        return;
      }

      const models = modelsForTier(hw.tier);
      this.models = models;
      await this.deps.config.update({
        tier: hw.tier,
        chatModel: models.chat,
        autocompleteModel: models.autocomplete,
        embeddingModel: models.embedding,
      });

      this.phase = "models";
      this.deps.post({
        step: 2,
        total: TOTAL_STEPS,
        title: "Models selected for your machine",
        detail:
          `Detected ${hw.chipBrand} · ${hw.totalMemoryGB}GB (Tier ${hw.tier}).\n\n` +
          `• Chat: ${models.chat} (${MODEL_SIZES[models.chat] ?? "?"})\n` +
          `• Autocomplete: ${models.autocomplete} (${MODEL_SIZES[models.autocomplete] ?? "?"})\n` +
          `• Embeddings: ${models.embedding} (${MODEL_SIZES[models.embedding] ?? "?"})`,
        mode: "prompt",
        actionId: "downloadModels",
        actionLabel: "Download Models",
      });
    } catch (err) {
      this.deps.logger.error("Onboarding hardware step failed", err);
      this.error(1, "Setup hit a snag", "Couldn't detect your hardware.", true);
    }
  }

  /** Steps 3–5: ensure Ollama, download models, index the workspace. */
  private async runDownloadAndIndex(): Promise<void> {
    if (!this.models) return this.runDetectAndSelect();
    this.phase = "downloading";
    const { ollama, contextService } = this.deps;
    try {
      // Step 3 — Ollama install + run.
      if (!ollama.isInstalled()) {
        this.info(3, "Installing Ollama…", "This takes about 30 seconds.");
        await ollama.install();
      }
      if (!(await ollama.isRunning())) {
        this.info(3, "Starting Ollama…", "Bringing up the local model server.");
        await ollama.start();
      }

      // Step 4 — model downloads with progress + ETA.
      await this.pull(this.models.chat, "chat model");
      await this.pull(this.models.autocomplete, "autocomplete model");
      await this.pull(this.models.embedding, "embedding model");

      // Step 5 — index the workspace.
      if (contextService) {
        this.info(
          5,
          "Indexing your codebase…",
          "Reading your project for context-aware chat.",
        );
        const stats = await contextService.indexWorkspace((p) => {
          const percent =
            p.total > 0 ? Math.round((p.current / p.total) * 100) : 0;
          this.deps.post({
            step: 5,
            total: TOTAL_STEPS,
            title: "Indexing your codebase…",
            detail: `${p.current} of ${p.total} files indexed`,
            mode: "progress",
            percent,
          });
        });
        this.deps.logger.info(
          `Onboarding indexed ${stats.fileCount} files, ${stats.chunkCount} chunks.`,
        );
      }

      // Step 6 — ready.
      this.phase = "ready";
      this.deps.post({
        step: 6,
        total: TOTAL_STEPS,
        title: "LocalPilot is ready",
        detail:
          "Try it:\n• Pause while typing for inline autocomplete\n" +
          "• Ask a question here in chat\n" +
          "• Type @codebase before a question to search your project\n\n" +
          "Everything runs on your machine.",
        mode: "ready",
        actionId: "startCoding",
        actionLabel: "Start Coding",
      });
    } catch (err) {
      this.deps.logger.error("Onboarding download/index step failed", err);
      this.error(
        4,
        "Setup hit a snag",
        "A download or indexing step failed. You can retry — Ollama resumes " +
          "partial downloads.",
        true,
      );
    }
  }

  /** Step 6 → done: persist completion, light up features, show chat. */
  private async finish(): Promise<void> {
    await this.deps.config.update({
      onboardingComplete: true,
      onboardingStep: 6,
    });
    this.deps.logger.info("Onboarding complete.");
    try {
      await this.deps.finalize();
    } catch (err) {
      this.deps.logger.error("Onboarding finalize failed", err);
    }
    this.deps.showChat();
  }

  /** Re-run whichever phase failed. */
  private async retry(): Promise<void> {
    if (this.phase === "models" || this.phase === "running") {
      await this.runDetectAndSelect();
    } else {
      await this.runDownloadAndIndex();
    }
  }

  // --- Helpers -------------------------------------------------------------

  private async pull(model: string, label: string): Promise<void> {
    if (await this.deps.ollama.hasModel(model)) return; // already present
    const started = Date.now();
    let lastPercent = -1;
    await this.deps.ollama.pullModel(model, (progress) => {
      if (progress.percent === undefined || progress.percent === lastPercent) {
        return;
      }
      lastPercent = progress.percent;
      this.deps.post({
        step: 4,
        total: TOTAL_STEPS,
        title: `Downloading ${label}…`,
        detail: `${model} — ${progress.status}`,
        mode: "progress",
        percent: progress.percent,
        eta: this.eta(started, progress.percent),
      });
    });
  }

  private info(step: number, title: string, detail: string): void {
    this.deps.post({ step, total: TOTAL_STEPS, title, detail, mode: "info" });
  }

  private error(
    step: number,
    title: string,
    detail: string,
    retry: boolean,
  ): void {
    this.deps.post({
      step,
      total: TOTAL_STEPS,
      title,
      detail,
      mode: "error",
      actionId: retry ? "retry" : undefined,
      actionLabel: retry ? "Try Again" : undefined,
    });
  }

  /** Remaining-time estimate for the download screen (see {@link formatEta}). */
  private eta(startedMs: number, percent: number): string | undefined {
    return formatEta(Date.now() - startedMs, percent);
  }
}
