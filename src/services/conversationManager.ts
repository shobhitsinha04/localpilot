import type { ChatMessage } from "../types";

// In-memory chat history for one session (FEATURES.md §3 "Multi-Turn
// Conversation Memory"). Holds the full user/assistant transcript that the UI
// displays; history is NOT persisted to disk and is cleared on New Chat or when
// VS Code closes. Trimming what is *sent to the model* is the PromptEngine's
// job — this class keeps everything. Free of `vscode` so it is unit-testable.

export class ConversationManager {
  private readonly history: ChatMessage[] = [];

  /** Append a user turn. */
  addUser(content: string): void {
    this.history.push({ role: "user", content });
  }

  /** Append a completed assistant turn. */
  addAssistant(content: string): void {
    this.history.push({ role: "assistant", content });
  }

  /** A copy of the full transcript (callers can't mutate internal state). */
  getHistory(): ChatMessage[] {
    return this.history.map((m) => ({ ...m }));
  }

  /** Clear the conversation (New Chat). */
  clear(): void {
    this.history.length = 0;
  }

  /** Number of turns recorded. */
  get length(): number {
    return this.history.length;
  }
}
