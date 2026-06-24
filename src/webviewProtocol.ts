// The postMessage contract between the chat webview and the extension host
// (ARCHITECTURE.md "Webview ↔ Extension Host"). Shared by both sides so the
// message shapes stay in sync. `vscode`-free and pure, so the parser is
// unit-testable (PHASES.md Phase 3 "unit test message passing protocol").

/** Actionable button attached to an inline error (UI_UX.md "Error Messages"). */
export type ErrorAction = "restart" | "retry";

/** Buttons the onboarding flow can show (ONBOARDING_FLOW.md). */
export type OnboardingActionId =
  | "getStarted"
  | "downloadModels"
  | "startCoding"
  | "retry";

/**
 * One render of the onboarding screen (Phase 6 WP2). The host drives the whole
 * screen with this single shape so the protocol stays small; the webview renders
 * by `mode`.
 */
export interface OnboardingView {
  /** Current step (0-based) and total, for the step indicator. */
  step: number;
  total: number;
  title: string;
  detail: string;
  /** info = spinner/text, progress = bar, prompt = button, error/ready. */
  mode: "info" | "progress" | "prompt" | "error" | "ready";
  /** 0–100 for `progress`. */
  percent?: number;
  /** e.g. "about 4 minutes remaining". */
  eta?: string;
  /** A button to show (prompt/error/ready modes). */
  actionId?: OnboardingActionId;
  actionLabel?: string;
}

/** Messages the webview sends to the extension host. */
export type WebviewMessage =
  | { type: "ready" }
  | { type: "sendMessage"; text: string }
  | { type: "stop" }
  | { type: "newChat" }
  | { type: "restart" }
  | { type: "retry" }
  | { type: "setAutocomplete"; enabled: boolean }
  | { type: "onboardingAction"; id: OnboardingActionId };

/** Messages the extension host sends to the webview. */
export type HostMessage =
  | { type: "init"; model: string; autocompleteEnabled: boolean }
  | { type: "onboarding"; view: OnboardingView }
  | { type: "retrievalStart" }
  | { type: "retrievalComplete"; files: string[] }
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
    case "retry":
      return { type: m.type };
    case "sendMessage":
      return typeof m.text === "string" && m.text.trim().length > 0
        ? { type: "sendMessage", text: m.text }
        : null;
    case "setAutocomplete":
      return typeof m.enabled === "boolean"
        ? { type: "setAutocomplete", enabled: m.enabled }
        : null;
    case "onboardingAction": {
      const ids: OnboardingActionId[] = [
        "getStarted",
        "downloadModels",
        "startCoding",
        "retry",
      ];
      return ids.includes(m.id as OnboardingActionId)
        ? { type: "onboardingAction", id: m.id as OnboardingActionId }
        : null;
    }
    default:
      return null;
  }
}
