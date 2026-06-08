// Webview-side script for the sidebar chat (DECISIONS 009: plain JS in the
// webview, no framework). Bundled by esbuild to media/webview.js and loaded
// with a CSP nonce. Renders markdown with marked (raw HTML neutralised) and
// highlights code with highlight.js; talks to the extension host over the typed
// postMessage protocol. All colours come from VS Code theme variables (see
// webview.css); the only exception is syntax-token colouring, which VS Code does
// not expose to webviews.

import hljs from "highlight.js/lib/common";
import { Marked } from "marked";

import type {
  ErrorAction,
  HostMessage,
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
  // Show the blinking cursor immediately so the panel signals "working" during
  // the (sometimes long) time before the first token arrives, instead of
  // sitting blank.
  assistantEl.innerHTML = '<span class="cursor"></span>';
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

newChatBtn.addEventListener("click", () => {
  post({ type: "newChat" });
  conversation
    .querySelectorAll(".msg, .msg-error")
    .forEach((el) => el.remove());
  emptyState.style.display = "";
  assistantEl = null;
  assistantBuffer = "";
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

// --- host → webview ---------------------------------------------------------
window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case "init":
      modelName.textContent = msg.model;
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
