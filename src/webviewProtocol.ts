// The postMessage contract between the chat webview and the extension host
// (ARCHITECTURE.md "Webview ↔ Extension Host"). Shared by both sides so the
// message shapes stay in sync. `vscode`-free and pure, so the parser is
// unit-testable (PHASES.md Phase 3 "unit test message passing protocol").

/** Actionable button attached to an inline error (UI_UX.md "Error Messages"). */
export type ErrorAction = "restart";

/** Messages the webview sends to the extension host. */
export type WebviewMessage =
  | { type: "ready" }
  | { type: "sendMessage"; text: string }
  | { type: "stop" }
  | { type: "newChat" }
  | { type: "restart" };

/** Messages the extension host sends to the webview. */
export type HostMessage =
  | { type: "init"; model: string }
  | { type: "streamStart" }
  | { type: "streamToken"; token: string }
  | { type: "streamEnd" }
  | { type: "error"; message: string; action?: ErrorAction };

/**
 * Validate and narrow an untrusted value received from the webview. Returns the
 * typed message, or null if the shape is unrecognised — the host must not act
 * on malformed input.
 */
export function parseWebviewMessage(raw: unknown): WebviewMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case "ready":
    case "stop":
    case "newChat":
    case "restart":
      return { type: m.type };
    case "sendMessage":
      return typeof m.text === "string" && m.text.trim().length > 0
        ? { type: "sendMessage", text: m.text }
        : null;
    default:
      return null;
  }
}
