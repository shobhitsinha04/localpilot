// Webview-side script for the sidebar chat (DECISIONS 009: plain JS in the
// webview, no framework). Bundled by esbuild to media/webview.js and loaded
// with a CSP nonce. Renders markdown with marked (raw HTML neutralised) and
// highlights code with highlight.js; talks to the extension host over the typed
// postMessage protocol. All colours come from VS Code theme variables (see
// webview.css); the only exception is syntax-token colouring, which VS Code does
// not expose to webviews.

import hljs from "highlight.js/lib/common";
import katex from "katex";
import { Marked, type TokenizerAndRendererExtension } from "marked";

import type {
  ErrorAction,
  HostMessage,
  OnboardingView,
  WebviewMessage,
} from "../webviewProtocol";

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
};
const vscode = acquireVsCodeApi();

function post(message: WebviewMessage): void {
  vscode.postMessage(message);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// marked with raw HTML neutralised — model output is rendered as markdown only,
// never as live HTML (defence in depth alongside the CSP).
const marked = new Marked({ gfm: true, breaks: false });
marked.use({
  renderer: {
    html: (token: { text: string } | string): string =>
      escapeHtml(typeof token === "string" ? token : token.text),
  },
});

// KaTeX math rendering. The chat/@codebase prompts ask the model to write math
// as $…$ (inline) and $$…$$ (display); these extensions turn that into rendered
// HTML (katex.min.css + fonts are linked by the webview). throwOnError:false so
// a malformed expression falls back to its source text instead of breaking the
// whole message.
function renderMath(text: string, displayMode: boolean): string {
  try {
    return katex.renderToString(text, { displayMode, throwOnError: false });
  } catch {
    return escapeHtml(text);
  }
}

const blockMath: TokenizerAndRendererExtension = {
  name: "blockMath",
  level: "block",
  start: (src) => {
    const i = src.indexOf("$$");
    return i < 0 ? undefined : i;
  },
  tokenizer(src) {
    const m = /^\$\$([\s\S]+?)\$\$/.exec(src);
    if (!m) return undefined;
    return { type: "blockMath", raw: m[0], text: m[1].trim() };
  },
  renderer: (token) => renderMath(String(token.text), true) + "\n",
};

const inlineMath: TokenizerAndRendererExtension = {
  name: "inlineMath",
  level: "inline",
  start: (src) => {
    const i = src.indexOf("$");
    return i < 0 ? undefined : i;
  },
  tokenizer(src) {
    // Require non-space just inside the delimiters so prose like "$5 and $10"
    // is left alone; only $…$ tight against content is treated as math.
    const m = /^\$(?!\s)([^$\n]+?)(?<!\s)\$/.exec(src);
    if (!m) return undefined;
    return { type: "inlineMath", raw: m[0], text: m[1].trim() };
  },
  renderer: (token) => renderMath(String(token.text), false),
};

marked.use({ extensions: [blockMath, inlineMath] });

function renderMarkdown(source: string): string {
  return marked.parse(source) as string;
}

// --- DOM references ---------------------------------------------------------
const conversation = document.getElementById("conversation") as HTMLElement;
const emptyState = document.getElementById("empty-state") as HTMLElement;
const input = document.getElementById("input") as HTMLTextAreaElement;
const sendBtn = document.getElementById("send") as HTMLButtonElement;
const newChatBtn = document.getElementById("new-chat") as HTMLButtonElement;
const modelName = document.getElementById("model-name") as HTMLElement;
const autocompleteToggle = document.getElementById(
  "toggle-autocomplete",
) as HTMLInputElement;

// Onboarding (WP2)
const obTitle = document.getElementById("ob-title") as HTMLElement;
const obDetail = document.getElementById("ob-detail") as HTMLElement;
const obSpinner = document.getElementById("ob-spinner") as HTMLElement;
const obProgress = document.getElementById("ob-progress") as HTMLElement;
const obBarFill = document.getElementById("ob-bar-fill") as HTMLElement;
const obEta = document.getElementById("ob-eta") as HTMLElement;
const obAction = document.getElementById("ob-action") as HTMLButtonElement;

// --- state ------------------------------------------------------------------
let generating = false;
let assistantBuffer = "";
let assistantEl: HTMLElement | null = null;
let renderQueued = false;

function isNearBottom(): boolean {
  return (
    conversation.scrollHeight -
      conversation.scrollTop -
      conversation.clientHeight <
    40
  );
}

function scrollToBottom(force: boolean): void {
  if (force || isNearBottom()) {
    conversation.scrollTop = conversation.scrollHeight;
  }
}

function hideEmptyState(): void {
  emptyState.style.display = "none";
}

// --- @codebase retrieval status --------------------------------------------
let retrievalEl: HTMLElement | null = null;

/** Show "Searching codebase…" while the host runs the RAG retrieval. */
function showRetrievalStatus(): void {
  hideEmptyState();
  retrievalEl = document.createElement("div");
  retrievalEl.className = "retrieval";
  retrievalEl.innerHTML =
    '<span class="retrieval-spinner" aria-hidden="true"></span>' +
    '<span class="retrieval-text">Searching codebase…</span>';
  conversation.appendChild(retrievalEl);
  scrollToBottom(true);
}

/** Remove any retrieval status/chips from a previous turn. */
function clearRetrieval(): void {
  conversation.querySelectorAll(".retrieval").forEach((el) => el.remove());
  retrievalEl = null;
}

/** Swap the status for the retrieved-file chips (or a "none found" note). */
function showRetrievalResult(files: string[]): void {
  if (!retrievalEl) return;
  if (files.length === 0) {
    retrievalEl.innerHTML =
      '<span class="retrieval-text">No relevant files found.</span>';
  } else {
    const chips = files
      .map((f) => `<span class="file-chip">${escapeHtml(f)}</span>`)
      .join("");
    retrievalEl.innerHTML =
      '<span class="retrieval-text">Searched codebase</span>' +
      `<span class="file-chips">${chips}</span>`;
  }
  // Detach so the chips stay in the transcript above the streamed answer.
  retrievalEl = null;
}

// --- message bubbles --------------------------------------------------------
function addUserBubble(text: string): void {
  hideEmptyState();
  const bubble = document.createElement("div");
  bubble.className = "msg msg-user";
  bubble.textContent = text; // plain text only (UI_UX.md user messages)
  conversation.appendChild(bubble);
  scrollToBottom(true);
}

function startAssistantBubble(): void {
  hideEmptyState();
  assistantBuffer = "";
  assistantEl = document.createElement("div");
  assistantEl.className = "msg msg-assistant streaming";
  // Show an animated typing indicator immediately so the panel clearly signals
  // "working" during the (sometimes long) wait before the first token arrives,
  // instead of sitting blank. The first rendered token replaces it (the dots are
  // swapped for the streaming text + cursor in scheduleRender).
  assistantEl.innerHTML =
    '<span class="typing" aria-label="Assistant is thinking">' +
    "<span></span><span></span><span></span></span>";
  conversation.appendChild(assistantEl);
  scrollToBottom(true);
}

function scheduleRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if (!assistantEl) return;
    const atBottom = isNearBottom();
    assistantEl.innerHTML =
      renderMarkdown(assistantBuffer) + '<span class="cursor"></span>';
    scrollToBottom(atBottom);
  });
}

function finishAssistantBubble(): void {
  if (assistantEl) {
    if (assistantBuffer.trim().length === 0) {
      // Nothing was generated (e.g. Stop pressed before the first token) —
      // remove the placeholder bubble rather than leaving it blank.
      assistantEl.remove();
    } else {
      assistantEl.classList.remove("streaming");
      assistantEl.innerHTML = renderMarkdown(assistantBuffer);
      enhanceCodeBlocks(assistantEl);
    }
  }
  assistantEl = null;
  assistantBuffer = "";
}

// Add language labels + copy buttons and syntax-highlight each code block.
function enhanceCodeBlocks(container: HTMLElement): void {
  container.querySelectorAll("pre > code").forEach((codeEl) => {
    const code = codeEl as HTMLElement;
    const pre = code.parentElement as HTMLElement;
    const langClass = [...code.classList].find((c) =>
      c.startsWith("language-"),
    );
    const language = langClass ? langClass.replace("language-", "") : "";

    try {
      hljs.highlightElement(code);
    } catch {
      // Unknown language — leave the text un-highlighted.
    }

    const toolbar = document.createElement("div");
    toolbar.className = "code-toolbar";
    if (language) {
      const label = document.createElement("span");
      label.className = "code-lang";
      label.textContent = language;
      toolbar.appendChild(label);
    }
    const copy = document.createElement("button");
    copy.className = "code-copy";
    copy.textContent = "Copy";
    copy.addEventListener("click", () => {
      void navigator.clipboard.writeText(code.textContent ?? "").then(() => {
        copy.textContent = "Copied";
        setTimeout(() => (copy.textContent = "Copy"), 1500);
      });
    });
    toolbar.appendChild(copy);
    pre.classList.add("has-toolbar");
    pre.appendChild(toolbar);
  });
}

function addErrorRow(message: string, action?: ErrorAction): void {
  const row = document.createElement("div");
  row.className = "msg-error";
  const text = document.createElement("span");
  text.textContent = `⚠ ${message}`;
  row.appendChild(text);
  if (action) {
    const btn = document.createElement("button");
    btn.className = "error-action";
    btn.textContent = action === "restart" ? "Restart" : "Retry";
    btn.addEventListener("click", () => {
      post({ type: action });
      row.remove();
    });
    row.appendChild(btn);
  }
  conversation.appendChild(row);
  scrollToBottom(true);
}

// --- input / generating state ----------------------------------------------
function setGenerating(value: boolean): void {
  generating = value;
  input.disabled = value;
  sendBtn.classList.toggle("stop", value);
  sendBtn.title = value ? "Stop" : "Send (Enter)";
  updateSendEnabled();
}

function updateSendEnabled(): void {
  // The button is always usable while generating (acts as Stop); otherwise only
  // when there is text to send.
  sendBtn.disabled = !generating && input.value.trim().length === 0;
}

function autoGrow(): void {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
}

function submit(): void {
  const text = input.value.trim();
  if (generating || text.length === 0) return;
  // Clear the previous turn's codebase chips so only the latest set shows.
  clearRetrieval();
  addUserBubble(text);
  post({ type: "sendMessage", text });
  input.value = "";
  autoGrow();
  updateSendEnabled();
}

// --- events -----------------------------------------------------------------
input.addEventListener("input", () => {
  autoGrow();
  updateSendEnabled();
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submit();
  } else if (e.key === "Escape" && generating) {
    e.preventDefault();
    post({ type: "stop" });
  }
});

sendBtn.addEventListener("click", () => {
  if (generating) {
    post({ type: "stop" });
  } else {
    submit();
  }
});

// New Chat clears the transcript, which can't be undone — so confirm first with
// an in-panel dialog (kept inside the chat UI rather than a VS Code system
// dialog). An already-empty chat just resets without prompting.
newChatBtn.addEventListener("click", () => {
  if (conversation.querySelector(".msg, .msg-error")) {
    showNewChatConfirm();
  } else {
    clearChat();
  }
});

function clearChat(): void {
  post({ type: "newChat" });
  conversation
    .querySelectorAll(".msg, .msg-error, .retrieval")
    .forEach((el) => el.remove());
  retrievalEl = null;
  emptyState.style.display = "";
  assistantEl = null;
  assistantBuffer = "";
}

// Build and show the in-panel "Start a new chat?" confirmation. Built from DOM
// nodes (not innerHTML) so all text is inert and the CSP stays strict.
function showNewChatConfirm(): void {
  const backdrop = document.createElement("div");
  backdrop.className = "confirm-backdrop";

  const dialog = document.createElement("div");
  dialog.className = "confirm-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");

  const title = document.createElement("div");
  title.className = "confirm-title";
  title.textContent = "Start a new chat?";

  const body = document.createElement("div");
  body.className = "confirm-text";
  body.textContent =
    "This clears the current conversation. It can't be undone.";

  const actions = document.createElement("div");
  actions.className = "confirm-actions";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "confirm-btn secondary";
  cancelBtn.textContent = "Cancel";
  const confirmBtn = document.createElement("button");
  confirmBtn.className = "confirm-btn primary";
  confirmBtn.textContent = "New Chat";
  actions.append(cancelBtn, confirmBtn);

  dialog.append(title, body, actions);
  backdrop.appendChild(dialog);

  const close = (): void => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
  };
  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  cancelBtn.addEventListener("click", close);
  confirmBtn.addEventListener("click", () => {
    clearChat();
    close();
  });
  // Click on the dimmed backdrop (outside the dialog) cancels.
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener("keydown", onKey);

  document.body.appendChild(backdrop);
  confirmBtn.focus();
}

// --- autocomplete toggle ----------------------------------------------------
// Persist the switch the moment it flips; the host applies it live.
autocompleteToggle.addEventListener("change", () => {
  post({ type: "setAutocomplete", enabled: autocompleteToggle.checked });
});

// Clickable "Try" suggestions in the empty state populate the input.
emptyState.querySelectorAll("[data-try]").forEach((el) => {
  el.addEventListener("click", () => {
    input.value = (el as HTMLElement).dataset.try ?? "";
    autoGrow();
    updateSendEnabled();
    input.focus();
  });
});

// --- onboarding (WP2) -------------------------------------------------------
function renderOnboarding(v: OnboardingView): void {
  document.body.classList.add("onboarding-active");
  obTitle.textContent = v.title;
  obDetail.textContent = v.detail;

  const isProgress = v.mode === "progress";
  obProgress.hidden = !isProgress;
  if (isProgress) {
    const pct = Math.max(0, Math.min(100, v.percent ?? 0));
    obBarFill.style.width = `${pct}%`;
    obEta.textContent = v.eta ?? "";
  }

  obSpinner.hidden = !(v.mode === "info" || isProgress);

  if (v.actionId && v.actionLabel) {
    obAction.hidden = false;
    obAction.disabled = false;
    obAction.textContent = v.actionLabel;
    obAction.dataset.action = v.actionId;
  } else {
    obAction.hidden = true;
  }
}

obAction.addEventListener("click", () => {
  const id = obAction.dataset.action;
  if (!id) return;
  obAction.disabled = true; // prevent double-trigger on slow steps
  post({ type: "onboardingAction", id } as WebviewMessage);
});

// --- host → webview ---------------------------------------------------------
window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case "init":
      // Leaving onboarding (or never in it) → show the chat UI.
      document.body.classList.remove("onboarding-active");
      modelName.textContent = msg.model;
      autocompleteToggle.checked = msg.autocompleteEnabled;
      break;
    case "onboarding":
      renderOnboarding(msg.view);
      break;
    case "retrievalStart":
      showRetrievalStatus();
      break;
    case "retrievalComplete":
      showRetrievalResult(msg.files);
      break;
    case "streamStart":
      setGenerating(true);
      startAssistantBubble();
      break;
    case "streamToken":
      assistantBuffer += msg.token;
      scheduleRender();
      break;
    case "streamEnd":
      finishAssistantBubble();
      setGenerating(false);
      input.focus();
      break;
    case "error":
      // Drop any partial streaming bubble, then show the error inline.
      if (assistantEl) {
        assistantEl.remove();
        assistantEl = null;
        assistantBuffer = "";
      }
      addErrorRow(msg.message, msg.action);
      setGenerating(false);
      break;
  }
});

// Ready to receive init.
post({ type: "ready" });
updateSendEnabled();
