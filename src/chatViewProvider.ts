import * as vscode from "vscode";

import { MAX_CONTEXT_FILE_LINES } from "./constants";
import { ConversationManager } from "./services/conversationManager";
import { OllamaError, type OllamaService } from "./services/ollamaService";
import { PromptEngine } from "./services/promptEngine";
import type { ConfigManager } from "./services/configManager";
import type { FileContext, Logger } from "./types";
import {
  parseWebviewMessage,
  type ErrorAction,
  type HostMessage,
} from "./webviewProtocol";

// The sidebar chat panel (FEATURES.md §3, DATA_FLOW.md §3, UI_UX.md). A
// WebviewViewProvider that owns the webview, gathers the active-file context,
// and orchestrates PromptEngine → OllamaService → streamed tokens → webview.
// This is the `vscode`-coupled layer; the logic it drives (ConversationManager,
// PromptEngine) stays `vscode`-free and unit-tested.

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "localpilot.chatView";

  private readonly conversation = new ConversationManager();
  private readonly prompt = new PromptEngine();
  private view?: vscode.WebviewView;
  /** Abort handle for the in-flight chat request (Stop button). */
  private currentRequest?: AbortController;
  /** The last message the user sent, re-sent by the "Retry" error action. */
  private pendingMessage?: string;
  /**
   * The most recent text editor the user worked in. Tracked because focusing
   * the chat webview clears `window.activeTextEditor`, which would otherwise
   * lose the current-file context (FEATURES.md §3).
   */
  private lastEditor?: vscode.TextEditor;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly ollama: OllamaService,
    private readonly config: ConfigManager,
    private readonly logger: Logger,
  ) {
    this.lastEditor = vscode.window.activeTextEditor;
  }

  /** Record the active editor so chat keeps its file context when focused. */
  noteActiveEditor(editor: vscode.TextEditor | undefined): void {
    if (editor) this.lastEditor = editor;
  }

  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, "media"),
        vscode.Uri.joinPath(this.extensionUri, "dist"),
      ],
    };
    view.webview.html = this.getHtml(view.webview);

    view.webview.onDidReceiveMessage((raw) => {
      const msg = parseWebviewMessage(raw);
      if (!msg) return;
      switch (msg.type) {
        case "ready":
          void this.sendInit();
          break;
        case "sendMessage":
          void this.handleUserMessage(msg.text);
          break;
        case "stop":
          this.currentRequest?.abort();
          break;
        case "newChat":
          this.conversation.clear();
          break;
        case "restart":
          void this.restartOllama();
          break;
        case "retry":
          if (this.pendingMessage)
            void this.handleUserMessage(this.pendingMessage);
          break;
      }
    });
  }

  private async sendInit(): Promise<void> {
    await this.config.load();
    const model = this.config.get().chatModel ?? "no model selected";
    this.post({ type: "init", model });
  }

  private async handleUserMessage(text: string): Promise<void> {
    // Remembered so the "Retry" action on an error can re-send this message.
    this.pendingMessage = text;
    const model = this.config.get().chatModel;
    if (!model) {
      this.postError("LocalPilot isn't set up yet. Run setup and try again.");
      return;
    }
    if (!(await this.ollama.isRunning())) {
      this.postError("LocalPilot isn't running.", "restart");
      return;
    }
    if (!(await this.ollama.hasModel(model))) {
      this.postError(
        `The chat model (${model}) isn't ready yet — it may still be downloading.`,
        "retry",
      );
      return;
    }

    // Build the prompt from the prior history, then record this user turn.
    const fileContext = this.gatherFileContext();
    const messages = this.prompt.buildChatPrompt(
      text,
      this.conversation.getHistory(),
      fileContext,
    );
    this.conversation.addUser(text);

    this.post({ type: "streamStart" });
    const request = new AbortController();
    this.currentRequest = request;
    let full = "";
    try {
      for await (const token of this.ollama.chat(
        messages,
        model,
        this.prompt.chatOptions(),
        request.signal,
      )) {
        full += token;
        this.post({ type: "streamToken", token });
      }
      if (full.trim().length > 0) {
        this.post({ type: "streamEnd" });
        this.conversation.addAssistant(full);
      } else if (request.signal.aborted) {
        // User pressed Stop before any token arrived — end quietly (the webview
        // drops the empty bubble); not an error.
        this.post({ type: "streamEnd" });
      } else {
        this.post({
          type: "error",
          message: "No response received. Try again.",
        });
      }
    } catch (err) {
      this.logger.error("Chat request failed", err);
      this.postError(this.friendlyError(err));
    } finally {
      this.currentRequest = undefined;
    }
  }

  /** Attempt to (re)start the Ollama daemon after an "isn't running" error. */
  private async restartOllama(): Promise<void> {
    try {
      await this.ollama.start();
    } catch (err) {
      this.logger.error("Failed to restart Ollama from chat", err);
      this.postError(
        "Couldn't restart LocalPilot. Check that Ollama is installed.",
      );
    }
  }

  /** Automatic context from the active editor (FEATURES.md §3). */
  private gatherFileContext(): FileContext | undefined {
    const editor = vscode.window.activeTextEditor ?? this.lastEditor;
    if (!editor) return undefined;
    const doc = editor.document;
    const withinLimit = doc.lineCount <= MAX_CONTEXT_FILE_LINES;
    const selection = editor.selection;
    return {
      filename: vscode.workspace.asRelativePath(doc.uri),
      languageId: doc.languageId,
      content: withinLimit ? doc.getText() : undefined,
      cursorLine: selection.active.line + 1,
      selectedText: selection.isEmpty ? undefined : doc.getText(selection),
    };
  }

  private friendlyError(err: unknown): string {
    if (
      err instanceof OllamaError &&
      /did not start responding/.test(err.message)
    ) {
      return "This took too long. Try a shorter question or restart LocalPilot.";
    }
    return "Something went wrong talking to LocalPilot. Try again.";
  }

  private postError(message: string, action?: ErrorAction): void {
    this.post({ type: "error", message, action });
  }

  private post(message: HostMessage): void {
    void this.view?.webview.postMessage(message);
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "webview.css"),
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "webview.js"),
    );
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>LocalPilot</title>
</head>
<body>
  <header class="header">
    <div class="header-titles">
      <span class="wordmark">LocalPilot</span>
      <span class="model-name" id="model-name"></span>
    </div>
    <div class="header-actions">
      <button class="icon-btn" id="new-chat" title="New Chat" aria-label="New Chat">
        <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M11 2.5l2.5 2.5L6 12.5 3 13l.5-3L11 2.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
        </svg>
      </button>
      <button class="icon-btn" id="more" title="More (coming soon)" aria-label="More" disabled>
        <svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
          <circle cx="3.5" cy="8" r="1.2"/><circle cx="8" cy="8" r="1.2"/><circle cx="12.5" cy="8" r="1.2"/>
        </svg>
      </button>
    </div>
  </header>

  <div class="conversation" id="conversation">
    <div class="empty-state" id="empty-state">
      <div class="empty-logo">◉ LocalPilot</div>
      <div class="empty-sub">Ask anything about your code.<br/>Type @codebase to search your project.</div>
      <button class="try-chip" data-try="Explain this file">Try: "Explain this file"</button>
      <button class="try-chip" data-try="How does auth work? @codebase">Try: "How does auth work? @codebase"</button>
    </div>
  </div>

  <div class="input-area">
    <textarea id="input" rows="1" placeholder="Ask LocalPilot..."></textarea>
    <div class="input-row">
      <button class="send-btn" id="send" title="Send (Enter)" aria-label="Send" disabled>
        <svg class="icon-send" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M8 13V3M8 3L4 7M8 3l4 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <svg class="icon-stop" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
          <rect x="4" y="4" width="8" height="8" rx="1.5"/>
        </svg>
      </button>
    </div>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function makeNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
