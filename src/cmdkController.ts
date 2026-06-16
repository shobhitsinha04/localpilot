import * as vscode from "vscode";

import { EDIT_CONTEXT_LINES, EDIT_SYSTEM_PROMPT } from "./constants";
import { cleanEditOutput } from "./services/editPostprocess";
import { diffLines } from "./services/lineDiff";
import { PromptEngine } from "./services/promptEngine";
import type { ConfigManager } from "./services/configManager";
import type { OllamaService } from "./services/ollamaService";
import type { Logger } from "./types";

// CMD+K inline editing (PHASES.md Phase 5, DATA_FLOW.md §2, UI_UX.md). The
// `vscode`-coupled state machine: capture selection → prompt for an instruction
// → stream a rewrite into the document live → show a red/green diff with an
// Accept/Reject CodeLens → finalise or restore the original exactly. The pure
// logic it drives (PromptEngine.buildEditPrompt, lineDiff, cleanEditOutput)
// stays `vscode`-free and unit-tested.
//
// Stable-API notes (see DECISIONS): the instruction box is a native
// `showInputBox` (a decoration cannot host an editable input), and the
// Accept/Reject affordance is a CodeLens (an interactive widget cannot float in
// the editor). Both are documented deviations from UI_UX.md's exact visuals.

const CONTEXT_KEY = "localpilot.cmdkActive";

type Phase = "streaming" | "diff";

interface EditSession {
  editor: vscode.TextEditor;
  phase: Phase;
  /** Exact original selection text — used to restore on Reject. */
  originalText: string;
  /** Cleaned final rewrite — used to finalise on Accept. */
  finalText: string;
  /** Where the (growing) edited block currently lives in the document. */
  range: vscode.Range;
  abort: AbortController;
  buffer: string;
}

export class CmdKController
  implements vscode.CodeLensProvider, vscode.Disposable
{
  private readonly prompt = new PromptEngine();
  private session?: EditSession;

  /** Serialises document edits during streaming (vscode edits can't overlap). */
  private rendering = false;
  private renderAgain = false;

  private readonly removedDeco: vscode.TextEditorDecorationType;
  private readonly addedDeco: vscode.TextEditorDecorationType;
  private readonly codeLensChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.codeLensChanged.event;

  constructor(
    private readonly ollama: OllamaService,
    private readonly config: ConfigManager,
    private readonly logger: Logger,
  ) {
    this.removedDeco = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor(
        "diffEditor.removedLineBackground",
      ),
      borderWidth: "0 0 0 2px",
      borderStyle: "solid",
      borderColor: new vscode.ThemeColor("editorGutter.deletedBackground"),
      overviewRulerColor: new vscode.ThemeColor(
        "editorOverviewRuler.deletedForeground",
      ),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    this.addedDeco = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor(
        "diffEditor.insertedLineBackground",
      ),
      borderWidth: "0 0 0 2px",
      borderStyle: "solid",
      borderColor: new vscode.ThemeColor("editorGutter.addedBackground"),
      overviewRulerColor: new vscode.ThemeColor(
        "editorOverviewRuler.addedForeground",
      ),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
  }

  // --------------------------------------------------------------------------
  // Command entry points
  // --------------------------------------------------------------------------

  /** CMD+K — rewrite the current selection per a typed instruction. */
  async start(): Promise<void> {
    if (this.session) {
      this.logger.info("[cmd+k] ignored — an edit is already in progress.");
      return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      this.logger.info("[cmd+k] ignored — no text selected.");
      return;
    }

    const model = this.config.get().chatModel;
    if (!model) {
      this.logger.info("[cmd+k] no chat model configured — edit unavailable.");
      void vscode.window.showWarningMessage(
        "LocalPilot isn't set up yet — run setup and try again.",
      );
      return;
    }

    const doc = editor.document;
    const selection = new vscode.Range(
      editor.selection.start,
      editor.selection.end,
    );
    const originalText = doc.getText(selection);
    const { prefix, suffix } = this.gatherContext(doc, selection);
    const selLines = selection.end.line - selection.start.line + 1;
    this.logger.info(
      `[cmd+k] triggered — ${selLines} line(s) selected in ${doc.languageId}; ` +
        "awaiting instruction…",
    );

    const instruction = await vscode.window.showInputBox({
      title: "✦ Edit",
      prompt: "Describe your edit",
      placeHolder: "Describe your edit…",
    });
    if (instruction === undefined || instruction.trim().length === 0) {
      this.logger.info("[cmd+k] cancelled at the instruction prompt.");
      return;
    }

    // The editor may have changed while the input box was open.
    if (vscode.window.activeTextEditor?.document !== doc) {
      this.logger.info("[cmd+k] aborted — the active editor changed.");
      return;
    }

    const session: EditSession = {
      editor,
      phase: "streaming",
      originalText,
      finalText: "",
      range: selection,
      abort: new AbortController(),
      buffer: "",
    };
    this.session = session;
    await this.setActive(true);
    this.logger.info(
      `[cmd+k] instruction: "${instruction}" — streaming a rewrite ` +
        `with ${model}…`,
    );

    const started = Date.now();
    let tokenCount = 0;
    let firstTokenMs = -1;
    try {
      const promptBody = this.prompt.buildEditPrompt(
        instruction,
        originalText,
        prefix,
        suffix,
        vscode.workspace.asRelativePath(doc.uri),
        doc.languageId,
      );
      for await (const token of this.ollama.generateStream(
        promptBody,
        model,
        this.prompt.editOptions(),
        session.abort.signal,
        EDIT_SYSTEM_PROMPT,
      )) {
        if (this.session !== session) return; // cancelled
        if (firstTokenMs < 0) {
          firstTokenMs = Date.now() - started;
          this.logger.info(
            `[cmd+k] first token in ${firstTokenMs}ms — streaming…`,
          );
        }
        tokenCount++;
        session.buffer += token;
        void this.scheduleRender(session);
      }
      if (this.session !== session) return;
      await this.flushRender(session);
      this.logger.info(
        `[cmd+k] stream complete — ${tokenCount} tokens, ` +
          `${session.buffer.length} chars in ${Date.now() - started}ms.`,
      );
      await this.showDiff(session);
    } catch (err) {
      this.logger.error("[cmd+k] edit failed", err);
      void vscode.window.showWarningMessage(
        "LocalPilot couldn't complete that edit.",
      );
      if (this.session === session) {
        this.session = undefined;
        await this.teardown(session, session.originalText);
      }
    }
  }

  /** CMD+Enter — keep the rewrite. */
  async accept(): Promise<void> {
    const session = this.session;
    if (!session || session.phase !== "diff") return;
    const lines = session.finalText.split("\n").length;
    this.session = undefined; // detach before any await
    await this.teardown(session, session.finalText);
    this.logger.info(`[cmd+k] accepted — rewrite applied (${lines} line(s)).`);
  }

  /** Esc — abort streaming or discard the rewrite, restoring the original. */
  async reject(): Promise<void> {
    const session = this.session;
    if (!session) return;
    const phase = session.phase;
    // Detach synchronously FIRST: the streaming loop's `this.session !== session`
    // check then bails (no showDiff), and no live render repaints the buffer over
    // the restore below.
    this.session = undefined;
    session.abort.abort();
    await this.teardown(session, session.originalText);
    this.logger.info(
      `[cmd+k] rejected during ${phase} — original restored exactly.`,
    );
  }

  // --------------------------------------------------------------------------
  // CodeLens (the Accept / Reject affordance above the diff)
  // --------------------------------------------------------------------------

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const session = this.session;
    if (
      !session ||
      session.phase !== "diff" ||
      document.uri.toString() !== session.editor.document.uri.toString()
    ) {
      return [];
    }
    const line = new vscode.Range(
      session.range.start.line,
      0,
      session.range.start.line,
      0,
    );
    return [
      new vscode.CodeLens(line, {
        title: "✓ Accept (⌘↩)",
        command: "localpilot.acceptEdit",
      }),
      new vscode.CodeLens(line, {
        title: "✗ Reject (Esc)",
        command: "localpilot.rejectEdit",
      }),
    ];
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  /** The {@link EDIT_CONTEXT_LINES} lines above and below the selection. */
  private gatherContext(
    doc: vscode.TextDocument,
    selection: vscode.Range,
  ): { prefix: string; suffix: string } {
    const startLine = Math.max(0, selection.start.line - EDIT_CONTEXT_LINES);
    const prefix = doc.getText(
      new vscode.Range(new vscode.Position(startLine, 0), selection.start),
    );
    const endLine = Math.min(
      doc.lineCount - 1,
      selection.end.line + EDIT_CONTEXT_LINES,
    );
    const suffix = doc.getText(
      new vscode.Range(
        selection.end,
        new vscode.Position(endLine, doc.lineAt(endLine).text.length),
      ),
    );
    return { prefix, suffix };
  }

  /** Coalesced live preview: replace the block with the cleaned buffer so far. */
  private async scheduleRender(session: EditSession): Promise<void> {
    if (this.rendering) {
      this.renderAgain = true;
      return;
    }
    this.rendering = true;
    do {
      this.renderAgain = false;
      if (this.session !== session) break;
      await this.replaceRange(
        session,
        session.range,
        cleanEditOutput(session.buffer),
      );
    } while (this.renderAgain);
    this.rendering = false;
  }

  /** Ensure the last streamed token is rendered before computing the diff. */
  private async flushRender(session: EditSession): Promise<void> {
    while (this.rendering) await delay(10);
    await this.replaceRange(
      session,
      session.range,
      cleanEditOutput(session.buffer),
    );
  }

  /** Swap the live preview for a red/green diff block and decorate it. */
  private async showDiff(session: EditSession): Promise<void> {
    const final = cleanEditOutput(session.buffer);
    session.finalText = final;
    if (final.length === 0) {
      this.logger.info("[cmd+k] empty rewrite — restoring original.");
      this.session = undefined;
      await this.teardown(session, session.originalText);
      return;
    }

    const rows = diffLines(session.originalText, final);
    const diffText = rows.map((r) => r.text).join("\n");
    await this.replaceRange(session, session.range, diffText);
    session.phase = "diff";

    const startLine = session.range.start.line;
    const removed: vscode.Range[] = [];
    const added: vscode.Range[] = [];
    rows.forEach((row, k) => {
      const lineRange = new vscode.Range(startLine + k, 0, startLine + k, 0);
      if (row.type === "removed") removed.push(lineRange);
      else if (row.type === "added") added.push(lineRange);
    });
    session.editor.setDecorations(this.removedDeco, removed);
    session.editor.setDecorations(this.addedDeco, added);
    this.codeLensChanged.fire();
    this.logger.info(
      `[cmd+k] diff ready — ${removed.length} removed / ${added.length} added ` +
        `line(s). Accept (⌘↩) or Reject (Esc).`,
    );
  }

  /** Replace `range` with `text`, recording the new range. Returns whether the
   * edit was applied (vscode resolves false if a competing edit intervened). */
  private async replaceRange(
    session: EditSession,
    range: vscode.Range,
    text: string,
  ): Promise<boolean> {
    const ok = await session.editor.edit((b) => b.replace(range, text), {
      undoStopBefore: false,
      undoStopAfter: false,
    });
    if (ok) {
      session.range = new vscode.Range(
        range.start,
        endPositionAfter(range.start, text),
      );
    }
    return ok;
  }

  /** Wait for any in-flight live render to finish. Once the session has been
   * detached (this.session set undefined) no new render starts, so this drains. */
  private async cancelRendering(): Promise<void> {
    while (this.rendering) await delay(10);
  }

  /**
   * Tear down a finished/cancelled session: drain any in-flight render, apply
   * the single final edit (`replacement` — the original text on Reject, the
   * rewrite on Accept, or null for none), then clear decorations, the CodeLens,
   * and the context key. The caller MUST detach `this.session` first (set it to
   * undefined) so the streaming loop and renders bail and cannot repaint over
   * this restore — that race was the cause of leftover diff lines on Esc.
   */
  private async teardown(
    session: EditSession,
    replacement: string | null,
  ): Promise<void> {
    await this.cancelRendering();
    if (replacement !== null) {
      const ok = await this.replaceRange(session, session.range, replacement);
      if (!ok) {
        this.logger.warn(
          "[cmd+k] could not write the final edit — the document changed; " +
            "use Undo if the text looks wrong.",
        );
      }
    }
    session.editor.setDecorations(this.removedDeco, []);
    session.editor.setDecorations(this.addedDeco, []);
    this.renderAgain = false;
    this.codeLensChanged.fire();
    await this.setActive(false);
  }

  private async setActive(active: boolean): Promise<void> {
    await vscode.commands.executeCommand("setContext", CONTEXT_KEY, active);
  }

  dispose(): void {
    this.removedDeco.dispose();
    this.addedDeco.dispose();
    this.codeLensChanged.dispose();
  }
}

/** Position at the end of `text` if inserted starting at `start`. */
function endPositionAfter(
  start: vscode.Position,
  text: string,
): vscode.Position {
  const lines = text.split("\n");
  return lines.length === 1
    ? new vscode.Position(start.line, start.character + text.length)
    : new vscode.Position(
        start.line + lines.length - 1,
        lines[lines.length - 1].length,
      );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
