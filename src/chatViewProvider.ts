import * as vscode from "vscode";

import type { ContextService } from "./contextService";
import type { OnboardingController } from "./onboardingController";
import { ConversationManager } from "./services/conversationManager";
import { OllamaError, type OllamaService } from "./services/ollamaService";
import {
  formatCodebaseContext,
  parseCodebaseQuery,
  PromptEngine,
} from "./services/promptEngine";
import type { ConfigManager } from "./services/configManager";
import type { ChatMessage, Logger, RetrievedChunk } from "./types";
import {
  parseWebviewMessage,
  type ErrorAction,
  type HostMessage,
  type OnboardingView,
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
  /** Drives the onboarding screen when setup isn't complete (WP2). */
  private onboarding?: OnboardingController;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly ollama: OllamaService,
    private readonly config: ConfigManager,
    private readonly logger: Logger,
    /** Shared context seam — absent when no workspace folder is open. */
    private readonly context?: ContextService,
  ) {}

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
          void this.onReady();
          break;
        case "onboardingAction":
          void this.onboarding?.handleAction(msg.id);
          break;
        case "sendMessage":
          void this.handleUserMessage(msg.text);
          break;
        case "stop":
          this.currentRequest?.abort();
          break;
        case "newChat":
          // The webview confirms (in-panel) before sending this, so by the time
          // it arrives the user has agreed to clear the conversation.
          this.conversation.clear();
          break;
        case "restart":
          void this.restartOllama();
          break;
        case "retry":
          if (this.pendingMessage)
            void this.handleUserMessage(this.pendingMessage);
          break;
        case "setAutocomplete":
          void this.setAutocomplete(msg.enabled);
          break;
      }
    });
  }

  /** Wire the onboarding controller (created in extension.ts) to this view. */
  attachOnboarding(controller: OnboardingController): void {
    this.onboarding = controller;
  }

  /** Send an onboarding screen to the webview (called by the controller). */
  postOnboarding(view: OnboardingView): void {
    this.post({ type: "onboarding", view });
  }

  /** Switch the webview from onboarding to chat (called when setup completes). */
  showChat(): void {
    void this.sendInit();
  }

  /**
   * On webview ready: show onboarding if setup isn't complete (and a controller
   * is wired), otherwise initialise the chat UI.
   */
  private async onReady(): Promise<void> {
    await this.config.load();
    if (!this.config.get().onboardingComplete && this.onboarding) {
      this.onboarding.begin();
    } else {
      await this.sendInit();
    }
  }

  private async sendInit(): Promise<void> {
    await this.config.load();
    const config = this.config.get();
    this.post({
      type: "init",
      model: config.chatModel ?? "no model selected",
      autocompleteEnabled: config.inlineCompletionsEnabled,
    });
  }

  /** Persist the autocomplete on/off switch; the provider reads it live. */
  private async setAutocomplete(enabled: boolean): Promise<void> {
    await this.config.update({ inlineCompletionsEnabled: enabled });
    this.logger.info(`Inline completions ${enabled ? "enabled" : "disabled"}.`);
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

    const { isCodebase, query } = parseCodebaseQuery(text);
    const fileContext = this.context?.gatherFileContext();

    // Build the prompt from the prior history, then record this user turn. For
    // @codebase, the model sees the cleaned query (token stripped) — that is
    // what we store in history so later turns stay consistent.
    let messages: ChatMessage[];
    if (isCodebase) {
      const built = await this.buildCodebasePrompt(query, fileContext);
      if (!built) return; // an inline notice was already posted
      messages = built;
      this.conversation.addUser(query);
    } else {
      messages = this.prompt.buildChatPrompt(
        text,
        this.conversation.getHistory(),
        fileContext,
      );
      this.conversation.addUser(text);
    }

    await this.streamAssistant(messages, model);
  }

  /**
   * Run the @codebase retrieval pipeline (DATA_FLOW.md §4) and assemble the
   * prompt. Posts retrieval status + file chips to the webview. Returns null
   * (after posting an inline notice) when the request can't proceed — no
   * workspace, an empty query, or an index that isn't ready.
   */
  private async buildCodebasePrompt(
    query: string,
    fileContext: ReturnType<NonNullable<ContextService["gatherFileContext"]>>,
  ): Promise<ChatMessage[] | null> {
    if (!this.config.get().onboardingComplete) {
      this.postError("Finish LocalPilot setup before using @codebase.");
      return null;
    }
    if (!this.context) {
      this.postError("Open a workspace folder to search your codebase.");
      return null;
    }
    if (query.length === 0) {
      this.postError("Add a question after @codebase.");
      return null;
    }
    if (!(await this.context.isIndexed())) {
      this.postError(
        "Your codebase isn't indexed yet — it may still be indexing. Try again shortly.",
        "retry",
      );
      return null;
    }

    this.post({ type: "retrievalStart" });
    let chunks: RetrievedChunk[] = [];
    try {
      chunks = await this.context.retrieve(query);
    } catch (err) {
      // A real retrieval failure is distinct from "no results" — tell the user
      // and abort rather than silently answering from zero context.
      this.logger.error("Codebase retrieval failed", err);
      this.post({ type: "retrievalComplete", files: [] });
      this.postError("Couldn't search your codebase. Try again.", "retry");
      return null;
    }
    // Show relative paths to the user and the model.
    const relChunks = chunks.map((c) => ({
      ...c,
      filename: vscode.workspace.asRelativePath(c.filename),
    }));
    const files = [...new Set(relChunks.map((c) => c.filename))];
    this.logger.info(
      `@codebase "${query}" → ${chunks.length} chunk(s) from ` +
        `${files.length} file(s): ${files.join(", ") || "(none)"}`,
    );
    this.post({ type: "retrievalComplete", files });

    return this.prompt.buildCodebaseChatPrompt(
      query,
      this.conversation.getHistory(),
      formatCodebaseContext(relChunks),
      fileContext,
    );
  }

  /** Stream a model response into the webview and record it on success. */
  private async streamAssistant(
    messages: ChatMessage[],
    model: string,
  ): Promise<void> {
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
    const katexCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "katex.min.css"),
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
  <link href="${katexCssUri}" rel="stylesheet" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>LocalPilot</title>
</head>
<body>
  <!-- Onboarding overlay (WP2). Hidden until the host sends an "onboarding"
       message; CSS hides the chat UI while body.onboarding-active is set. -->
  <section class="onboarding" id="onboarding" aria-live="polite">
    <div class="ob-logo">◉ LocalPilot</div>
    <div class="ob-title" id="ob-title"></div>
    <div class="ob-detail" id="ob-detail"></div>
    <div class="ob-spinner" id="ob-spinner" hidden></div>
    <div class="ob-progress" id="ob-progress" hidden>
      <div class="ob-bar"><div class="ob-bar-fill" id="ob-bar-fill"></div></div>
      <div class="ob-eta" id="ob-eta"></div>
    </div>
    <button class="ob-action" id="ob-action" hidden></button>
  </section>

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
      <label class="header-switch" title="Toggle inline autocomplete on/off">
        <span class="header-switch-label">Autocomplete</span>
        <span class="switch">
          <input type="checkbox" id="toggle-autocomplete" title="Toggle inline autocomplete on/off" aria-label="Toggle autocomplete" />
          <span class="slider"></span>
        </span>
      </label>
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
