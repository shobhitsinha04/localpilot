import {
  CHAT_SYSTEM_PROMPT,
  CHAT_TEMPERATURE,
  CHAT_TOP_P,
  CODEBASE_SYSTEM_PROMPT,
  COMPLETION_STOP,
  COMPLETION_TEMPERATURE,
  COMPLETION_TOP_P,
  EDIT_TEMPERATURE,
  EDIT_TOP_P,
  MAX_HISTORY_MESSAGES,
} from "../constants";
import type {
  ChatMessage,
  FileContext,
  OllamaRequestOptions,
  RetrievedChunk,
} from "../types";

/** Matches the @codebase trigger token as a whole word, anywhere in the text. */
const CODEBASE_TOKEN_RE = /(^|\s)@codebase\b/i;

/**
 * Detect the @codebase trigger and strip every occurrence, returning the
 * cleaned natural-language query (DATA_FLOW.md §4 step 1). The token may appear
 * anywhere — the empty-state chips put it both leading and trailing. Pure and
 * `vscode`-free so it is unit-tested directly.
 */
export function parseCodebaseQuery(text: string): {
  isCodebase: boolean;
  query: string;
} {
  if (!CODEBASE_TOKEN_RE.test(text)) return { isCodebase: false, query: text };
  const query = text
    .replace(/@codebase/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { isCodebase: true, query };
}

/**
 * Render retrieved chunks into the labelled context block of DATA_FLOW.md §4:
 * `// File: <name> (lines a-b)` followed by the chunk text. The caller passes
 * chunks with display-friendly (relative) filenames.
 */
export function formatCodebaseContext(chunks: RetrievedChunk[]): string {
  return chunks
    .map(
      (c) =>
        `// File: ${c.filename} (lines ${c.startLine}-${c.endLine})\n${c.text}`,
    )
    .join("\n\n");
}

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

  /**
   * Build the chat message array for an @codebase turn (DATA_FLOW.md §4): the
   * codebase system prompt, the retrieved code context block, the current file
   * context (if any), the trimmed history, then the user question (with the
   * @codebase token already stripped). Empty context blocks are omitted.
   */
  buildCodebaseChatPrompt(
    userMessage: string,
    history: ChatMessage[],
    codebaseContext: string,
    fileContext?: FileContext,
  ): ChatMessage[] {
    const parts = [CODEBASE_SYSTEM_PROMPT];
    if (codebaseContext.trim().length > 0) {
      parts.push(
        `Relevant code from the user's project:\n\n${codebaseContext}`,
      );
    }
    if (fileContext) parts.push(formatFileContext(fileContext));

    return [
      { role: "system", content: parts.join("\n\n") },
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

  /**
   * Build the prompt body for a CMD+K rewrite (DATA_FLOW.md §2). Pairs with the
   * EDIT_SYSTEM_PROMPT constant, which the caller sends in the request's `system`
   * field. `prefix`/`suffix` are the context lines above/below the selection;
   * empty context blocks are omitted so the model isn't handed blank fences.
   */
  buildEditPrompt(
    instruction: string,
    selection: string,
    prefix: string,
    suffix: string,
    filename: string,
    language: string,
  ): string {
    const parts: string[] = [`File: ${filename} (language: ${language})`, ""];
    if (prefix.trim().length > 0) {
      parts.push("Code before the selection:", "```", prefix, "```", "");
    }
    parts.push("The selected code to rewrite:", "```", selection, "```", "");
    if (suffix.trim().length > 0) {
      parts.push("Code after the selection:", "```", suffix, "```", "");
    }
    parts.push(`Instruction: ${instruction}`);
    return parts.join("\n");
  }

  /** Sampling options for a CMD+K rewrite (DATA_FLOW.md §2). */
  editOptions(): OllamaRequestOptions {
    return { temperature: EDIT_TEMPERATURE, top_p: EDIT_TOP_P };
  }
}
