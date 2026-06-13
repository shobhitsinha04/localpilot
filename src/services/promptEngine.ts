import {
  CHAT_SYSTEM_PROMPT,
  CHAT_TEMPERATURE,
  CHAT_TOP_P,
  COMPLETION_STOP,
  COMPLETION_TEMPERATURE,
  COMPLETION_TOP_P,
  MAX_HISTORY_MESSAGES,
} from "../constants";
import type { ChatMessage, FileContext, OllamaRequestOptions } from "../types";

// Qwen2.5-Coder fill-in-the-middle (FIM) special tokens. The model is trained
// to predict the code at <|fim_middle|> given the surrounding prefix and suffix.
//
// Two things were settled by a live harness against Ollama during Phase 4:
//   1. The request must be sent with `raw: true` (see OllamaService.complete);
//      otherwise Ollama wraps these tokens in the instruct chat template and the
//      model replies with prose + markdown fences instead of completing.
//   2. Naming the file via a leading <|file_sep|> made the model append spurious
//      ``` fences, so the filename/language are deliberately left out — plain
//      FIM gives the cleanest completions.
const FIM_PREFIX = "<|fim_prefix|>";
const FIM_SUFFIX = "<|fim_suffix|>";
const FIM_MIDDLE = "<|fim_middle|>";

// Assembles the message array sent to Ollama for sidebar chat (DATA_FLOW.md §3).
// Pure and `vscode`-free so prompt assembly is unit-testable; the chat view
// provider gathers the inputs and transports the result. Prompt assembly lives
// here (not in OllamaService) per ARCHITECTURE.md's component boundaries.

/** Render the active-file context block injected into the system prompt. */
export function formatFileContext(fc: FileContext): string {
  const lines = [
    `The user's current file is ${fc.filename} (${fc.languageId}).`,
  ];
  if (fc.cursorLine !== undefined) {
    lines.push(`The cursor is on line ${fc.cursorLine}.`);
  }
  if (fc.selectedText && fc.selectedText.length > 0) {
    lines.push(`The user has selected:\n${fc.selectedText}`);
  }
  if (fc.content !== undefined) {
    lines.push(`File contents:\n\`\`\`${fc.languageId}\n${fc.content}\n\`\`\``);
  } else {
    lines.push("(The file is too large to include in full.)");
  }
  return lines.join("\n");
}

export class PromptEngine {
  /**
   * Build the chat message array: a system prompt (with the current file
   * silently injected), the trimmed conversation history, then the new user
   * message. History is trimmed to the most recent {@link MAX_HISTORY_MESSAGES}
   * messages; the system prompt and current message are never trimmed.
   */
  buildChatPrompt(
    userMessage: string,
    history: ChatMessage[],
    fileContext?: FileContext,
  ): ChatMessage[] {
    const system = fileContext
      ? `${CHAT_SYSTEM_PROMPT}\n\n${formatFileContext(fileContext)}`
      : CHAT_SYSTEM_PROMPT;

    return [
      { role: "system", content: system },
      ...history.slice(-MAX_HISTORY_MESSAGES),
      { role: "user", content: userMessage },
    ];
  }

  /** Sampling options for chat (DATA_FLOW.md §3). */
  chatOptions(): OllamaRequestOptions {
    return { temperature: CHAT_TEMPERATURE, top_p: CHAT_TOP_P };
  }

  /**
   * Assemble a Qwen2.5-Coder FIM prompt for inline completion (DATA_FLOW.md §1).
   * `prefix` is the code immediately before the cursor and `suffix` the code
   * after it; the model predicts the text that fills the gap. Must be sent with
   * `raw: true` so Ollama does not apply the instruct chat template.
   */
  buildFIMPrompt(prefix: string, suffix: string): string {
    return `${FIM_PREFIX}${prefix}${FIM_SUFFIX}${suffix}${FIM_MIDDLE}`;
  }

  /** Sampling options for inline completion (DATA_FLOW.md §1). */
  completionOptions(): OllamaRequestOptions {
    return {
      temperature: COMPLETION_TEMPERATURE,
      top_p: COMPLETION_TOP_P,
      stop: COMPLETION_STOP,
    };
  }
}
