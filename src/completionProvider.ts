import * as vscode from "vscode";

import {
  COMPLETION_DEBOUNCE_MS,
  COMPLETION_KEEP_ALIVE,
  COMPLETION_PREFIX_LINES,
  COMPLETION_SUFFIX_LINES,
  COMPLETION_TIMEOUT_MS,
} from "./constants";
import { cleanCompletion } from "./services/completionPostprocess";
import type { ConfigManager } from "./services/configManager";
import type { OllamaService } from "./services/ollamaService";
import { PromptEngine } from "./services/promptEngine";
import type { Logger } from "./types";

// Inline (ghost-text) completions (PHASES.md Phase 4, DATA_FLOW.md §1). This is
// the `vscode`-coupled layer: it pulls the prefix/suffix around the cursor and
// drives PromptEngine (FIM prompt) → OllamaService.complete() → post-process →
// InlineCompletionItem. The logic it relies on (FIM assembly, output cleaning)
// stays `vscode`-free and unit-tested.
//
// Completions are best-effort: anything that goes wrong (Ollama down, timeout, a
// superseding keystroke) results in *no* suggestion, never a user-facing error.

export class CompletionProvider implements vscode.InlineCompletionItemProvider {
  private readonly prompt = new PromptEngine();
  /** Suppresses repeated failure logs until the next success (avoids spam). */
  private failureLogged = false;
  /** Count of in-flight requests; the status-bar spinner shows while > 0. */
  private inFlight = 0;

  constructor(
    private readonly ollama: OllamaService,
    private readonly config: ConfigManager,
    private readonly logger: Logger,
    private readonly statusBar: vscode.StatusBarItem,
  ) {}

  /** Show/hide the "generating…" status-bar spinner, ref-counted so overlapping
   * requests don't hide it early. */
  private setBusy(busy: boolean): void {
    if (busy) {
      this.inFlight++;
      this.statusBar.show();
    } else {
      this.inFlight = Math.max(0, this.inFlight - 1);
      if (this.inFlight === 0) this.statusBar.hide();
    }
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    const config = this.config.get();
    // Honour the chat-panel toggle and bail before any work when off.
    if (!config.inlineCompletionsEnabled) return undefined;
    const model = config.autocompleteModel;
    if (!model) return undefined;

    // Debounce: a newer keystroke cancels `token`, so wait out the idle window
    // and bail if another request supersedes this one in the meantime.
    if (await this.debounced(token)) return undefined;

    const { prefix, suffix } = this.extractContext(document, position);
    // Nothing meaningful before the cursor — don't ask the model to invent code.
    if (prefix.trim().length === 0) return undefined;

    const controller = new AbortController();
    const cancelSub = token.onCancellationRequested(() => controller.abort());
    const started = Date.now();
    this.setBusy(true);
    try {
      this.logger.info(
        `[completion] requesting (${model}, prefix ${lineCount(prefix)}L / ` +
          `suffix ${lineCount(suffix)}L, timeout ${COMPLETION_TIMEOUT_MS}ms)...`,
      );
      const raw = await this.ollama.complete(
        this.prompt.buildFIMPrompt(prefix, suffix),
        model,
        this.prompt.completionOptions(),
        controller.signal,
        COMPLETION_TIMEOUT_MS,
        COMPLETION_KEEP_ALIVE,
      );
      const ms = Date.now() - started;
      this.failureLogged = false;

      if (token.isCancellationRequested) {
        this.logger.info(`[completion] discarded after ${ms}ms (superseded).`);
        return undefined;
      }
      if (raw.length === 0) {
        const timedOut = ms >= COMPLETION_TIMEOUT_MS - 100;
        this.logger.info(
          timedOut
            ? `[completion] TIMED OUT after ${ms}ms (limit ${COMPLETION_TIMEOUT_MS}ms) — model too slow.`
            : `[completion] no output in ${ms}ms (model returned nothing or was aborted).`,
        );
        return undefined;
      }

      const text = cleanCompletion(raw, suffix);
      if (text.length === 0) {
        this.logger.info(
          `[completion] replied in ${ms}ms but nothing usable after cleanup ` +
            `(raw ${preview(raw)}).`,
        );
        return undefined;
      }

      this.logger.info(`[completion] served in ${ms}ms → ${preview(text)}`);
      return [
        new vscode.InlineCompletionItem(
          text,
          new vscode.Range(position, position),
        ),
      ];
    } catch (err) {
      // Abort (timeout/supersede) already resolves to "" inside complete(); only
      // genuine failures reach here. Log once until the next success so a downed
      // Ollama doesn't flood the log on every keystroke.
      if (!this.failureLogged) {
        this.logger.warn(
          `[completion] failed after ${Date.now() - started}ms: ${String(err)}`,
        );
        this.failureLogged = true;
      }
      return undefined;
    } finally {
      this.setBusy(false);
      cancelSub.dispose();
    }
  }

  /** The 20 lines before the cursor and 10 after, as the FIM prefix/suffix. */
  private extractContext(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): { prefix: string; suffix: string } {
    const startLine = Math.max(0, position.line - COMPLETION_PREFIX_LINES);
    const prefix = document.getText(
      new vscode.Range(new vscode.Position(startLine, 0), position),
    );

    const endLine = Math.min(
      document.lineCount - 1,
      position.line + COMPLETION_SUFFIX_LINES,
    );
    const endChar = document.lineAt(endLine).text.length;
    const suffix = document.getText(
      new vscode.Range(position, new vscode.Position(endLine, endChar)),
    );
    return { prefix, suffix };
  }

  /**
   * Resolve `true` if the request is cancelled within the debounce window
   * (a newer keystroke superseded it), or `false` once the window elapses.
   */
  private debounced(token: vscode.CancellationToken): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        sub.dispose();
        resolve(false);
      }, COMPLETION_DEBOUNCE_MS);
      const sub = token.onCancellationRequested(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}

/** Number of lines in a chunk of text (for diagnostic logging). */
function lineCount(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

/** A short, single-line, quoted preview of text for the Output channel. */
function preview(text: string): string {
  const oneLine = text.replace(/\n/g, "\\n");
  return JSON.stringify(
    oneLine.length > 60 ? `${oneLine.slice(0, 60)}…` : oneLine,
  );
}
