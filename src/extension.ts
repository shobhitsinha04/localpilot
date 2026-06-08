import * as vscode from "vscode";

import { ChatViewProvider } from "./chatViewProvider";
import { ConfigManager } from "./services/configManager";
import { HardwareDetector, modelsForTier } from "./services/hardwareDetector";
import { IndexManager } from "./services/indexManager";
import { OllamaService } from "./services/ollamaService";
import type { Logger } from "./types";

// Phase 1 — Ollama Integration + Hardware Detection, then
// Phase 2 — Codebase Indexing (PHASES.md).
//
// On activation the extension runs a developer smoke test (not user-facing yet):
// detect hardware -> pick tier/models -> install/start Ollama -> pull the chat
// model -> send "say hello" -> [Phase 2] pull the embedding model -> index the
// workspace into LanceDB -> run a test query -> register a watcher for
// incremental updates. All progress goes to the Output Channel. There is no
// observability proxy in v1 (Helicone deferred — DECISIONS 011); the Ollama
// Service talks to Ollama directly.

let ollamaService: OllamaService | undefined;
/** Guards against overlapping smoke-test runs (activation + manual command). */
let smokeTestInFlight = false;
/** Set once the incremental-index file watcher has been registered. */
let indexWatcherRegistered = false;

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel("LocalPilot");
  context.subscriptions.push(channel);
  const logger = createLogger(channel);

  // Create the service synchronously here (not inside the async smoke test) so
  // deactivate() can always stop the `ollama serve` process we may have spawned.
  ollamaService = new OllamaService({ logger });
  const ollama = ollamaService;

  context.subscriptions.push(
    vscode.commands.registerCommand("localpilot.helloWorld", () => {
      vscode.window.showInformationMessage("Hello World from LocalPilot!");
    }),
    vscode.commands.registerCommand("localpilot.runSmokeTest", () => {
      void runSmokeTest(context, logger, channel, ollama);
    }),
  );

  // Phase 3 — register the sidebar chat panel (FEATURES.md §3).
  const chatConfig = new ConfigManager(context.globalStorageUri.fsPath, logger);
  const chatProvider = new ChatViewProvider(
    context.extensionUri,
    ollama,
    chatConfig,
    logger,
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      chatProvider,
      // Keep the webview (and its conversation) alive when the user switches to
      // another activity-bar view, so chat history isn't lost (FEATURES.md §3).
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    // Track the active editor so chat keeps the current-file context even while
    // the chat input is focused (which clears window.activeTextEditor).
    vscode.window.onDidChangeActiveTextEditor((editor) =>
      chatProvider.noteActiveEditor(editor),
    ),
  );

  // Fire-and-forget so a long model pull never blocks VS Code activation.
  void runSmokeTest(context, logger, channel, ollama);
}

export function deactivate(): void {
  // Stop the `ollama serve` process if this extension started it.
  ollamaService?.stop();
  ollamaService = undefined;
}

/** Wrap a VS Code OutputChannel in the service-facing Logger interface. */
function createLogger(channel: vscode.OutputChannel): Logger {
  const stamp = (): string => new Date().toISOString();
  return {
    info: (message) => channel.appendLine(`[INFO  ${stamp()}] ${message}`),
    warn: (message) => channel.appendLine(`[WARN  ${stamp()}] ${message}`),
    error: (message, err) => {
      const detail =
        err instanceof Error
          ? ` :: ${err.stack ?? err.message}`
          : err !== undefined
            ? ` :: ${String(err)}`
            : "";
      channel.appendLine(`[ERROR ${stamp()}] ${message}${detail}`);
    },
  };
}

/**
 * Developer smoke test for Phase 1. Surfaces all progress in the Output
 * Channel and never throws — failures are logged and a single notification
 * points the developer to the channel.
 */
async function runSmokeTest(
  context: vscode.ExtensionContext,
  logger: Logger,
  channel: vscode.OutputChannel,
  ollama: OllamaService,
): Promise<void> {
  if (smokeTestInFlight) {
    logger.warn("Smoke test already running; ignoring duplicate trigger.");
    return;
  }
  smokeTestInFlight = true;
  channel.show(true);
  logger.info("LocalPilot Phase 1 smoke test starting...");

  try {
    const config = new ConfigManager(context.globalStorageUri.fsPath, logger);
    await config.load();

    // 1. Hardware detection + tier mapping.
    const detector = new HardwareDetector(logger);
    const hw = await detector.detect();

    if (!hw.supported) {
      const reason =
        hw.unsupportedReason ?? "LocalPilot v1 supports Apple Silicon only.";
      logger.warn(reason);
      void vscode.window.showWarningMessage(`LocalPilot: ${reason}`);
      return;
    }

    logger.info(
      `Detected: ${hw.chipBrand} — ${hw.totalMemoryGB}GB unified memory, ` +
        `${hw.availableDiskGB}GB free disk, macOS ${hw.macosVersion || "unknown"}. ` +
        `Tier ${hw.tier}.`,
    );
    if (hw.detectionFailed) {
      logger.warn("Hardware detection partially failed; defaulted to Tier 2.");
    }
    if (!hw.metalSupported) {
      logger.warn(
        "macOS is below Ventura (13). Metal acceleration is unavailable; " +
          "models will run on CPU and be slower.",
      );
    }

    // 2. Record tier + model selection in config.json.
    const models = modelsForTier(hw.tier);
    logger.info(
      `Selected models — chat: ${models.chat}, ` +
        `autocomplete: ${models.autocomplete}, embedding: ${models.embedding}`,
    );
    await config.update({
      tier: hw.tier,
      chatModel: models.chat,
      autocompleteModel: models.autocomplete,
      embeddingModel: models.embedding,
    });

    // 3. Ensure Ollama is installed and running.
    if (!ollama.isInstalled()) {
      logger.info("Ollama not found. Installing...");
      await ollama.install();
      logger.info("Ollama installed.");
    } else {
      logger.info("Ollama found.");
    }

    if (await ollama.isRunning()) {
      logger.info("Ollama is already running.");
    } else {
      logger.info("Starting Ollama daemon...");
      await ollama.start();
      logger.info("Ollama is running.");
    }

    // 4. Pull the chat model (idempotent; fast if already present).
    logger.info(
      `Pulling chat model ${models.chat} (first run may take a while)...`,
    );
    let lastPercent = -1;
    await ollama.pullModel(models.chat, (progress) => {
      if (progress.percent !== undefined && progress.percent !== lastPercent) {
        lastPercent = progress.percent;
        logger.info(
          `  ${models.chat}: ${progress.status} ${progress.percent}%`,
        );
      }
    });
    logger.info(`Chat model ready: ${models.chat}`);

    // 5. Send a test prompt and log the response.
    logger.info('Sending test prompt: "say hello"...');
    let response = "";
    for await (const token of ollama.chat(
      [{ role: "user", content: "say hello" }],
      models.chat,
    )) {
      response += token;
    }
    logger.info(`Model response: ${response.trim()}`);
    logger.info("Phase 1 smoke test complete. ✓");

    // 6. Phase 2 — index the workspace and run a test query.
    await runIndexingSmokeTest(
      context,
      logger,
      config,
      ollama,
      models.embedding,
    );
  } catch (err) {
    logger.error("Phase 1 smoke test failed", err);
    void vscode.window.showErrorMessage(
      "LocalPilot smoke test failed — see the LocalPilot output channel for details.",
    );
  } finally {
    smokeTestInFlight = false;
  }
}

/**
 * Developer smoke test for Phase 2 (Codebase Indexing). Pulls the embedding
 * model, indexes the open workspace into LanceDB, logs the top retrieved chunks
 * for a sample query, and registers a file watcher for incremental updates.
 * Runs inside the Phase 1 try/catch — it may throw; the caller logs.
 */
async function runIndexingSmokeTest(
  context: vscode.ExtensionContext,
  logger: Logger,
  config: ConfigManager,
  ollama: OllamaService,
  embeddingModel: string,
): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    logger.warn("No workspace folder open; skipping the indexing smoke test.");
    return;
  }

  logger.info(`Pulling embedding model ${embeddingModel}...`);
  let lastPercent = -1;
  await ollama.pullModel(embeddingModel, (progress) => {
    if (progress.percent !== undefined && progress.percent !== lastPercent) {
      lastPercent = progress.percent;
      logger.info(
        `  ${embeddingModel}: ${progress.status} ${progress.percent}%`,
      );
    }
  });
  logger.info(`Embedding model ready: ${embeddingModel}`);

  const indexManager = new IndexManager({
    ollama,
    storageDir: context.globalStorageUri.fsPath,
    workspacePath: folder.uri.fsPath,
    embeddingModel,
    logger,
  });

  logger.info(`Indexing workspace ${folder.uri.fsPath}...`);
  const stats = await indexManager.indexWorkspace((progress) => {
    if (progress.current === progress.total || progress.current % 10 === 0) {
      logger.info(`  indexed ${progress.current}/${progress.total} files`);
    }
  });
  logger.info(
    `Indexed ${stats.fileCount} files into ${stats.chunkCount} chunks.`,
  );

  // Record index state in config.json (workspaceIndexes keyed by hash).
  await config.update({
    workspaceIndexes: {
      ...config.get().workspaceIndexes,
      [stats.workspaceHash]: {
        indexed: true,
        fileCount: stats.fileCount,
        workspaceHash: stats.workspaceHash,
      },
    },
  });

  // Run a sample query and log the top hits.
  const query = "what colors were used for the links ";
  const hits = await indexManager.search(query);
  logger.info(`Top ${Math.min(3, hits.length)} chunks for "${query}":`);
  hits.slice(0, 3).forEach((hit, i) => {
    const rel = vscode.workspace.asRelativePath(hit.filename);
    logger.info(
      `  ${i + 1}. ${rel}:${hit.startLine}-${hit.endLine} ` +
        `(score ${hit.score.toFixed(3)}, sim ${hit.similarity.toFixed(3)})`,
    );
  });

  registerIndexWatcher(context, logger, indexManager);
  logger.info("Phase 2 indexing smoke test complete. ✓");
}

/**
 * Wire VS Code's file watcher to incremental index updates (DATA_FLOW.md §6).
 * Registered once per session; lives here (not in IndexManager) so the service
 * stays free of the `vscode` API.
 */
function registerIndexWatcher(
  context: vscode.ExtensionContext,
  logger: Logger,
  indexManager: IndexManager,
): void {
  if (indexWatcherRegistered) return;
  indexWatcherRegistered = true;

  const watcher = vscode.workspace.createFileSystemWatcher("**/*");
  const update = (uri: vscode.Uri): void => {
    void indexManager
      .updateFile(uri.fsPath)
      .catch((err) =>
        logger.warn(`Index update failed for ${uri.fsPath}: ${String(err)}`),
      );
  };
  watcher.onDidCreate(update);
  watcher.onDidChange(update);
  watcher.onDidDelete((uri) => {
    void indexManager
      .deleteFile(uri.fsPath)
      .catch((err) =>
        logger.warn(`Index delete failed for ${uri.fsPath}: ${String(err)}`),
      );
  });
  context.subscriptions.push(watcher);
  logger.info("File watcher registered for incremental index updates.");
}
