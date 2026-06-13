import { describe, expect, it } from "vitest";

import {
  CHAT_SYSTEM_PROMPT,
  CHAT_TEMPERATURE,
  CHAT_TOP_P,
  COMPLETION_STOP,
  COMPLETION_TEMPERATURE,
  COMPLETION_TOP_P,
  MAX_HISTORY_MESSAGES,
} from "../src/constants";
import { PromptEngine } from "../src/services/promptEngine";
import type { ChatMessage, FileContext } from "../src/types";

const engine = new PromptEngine();

describe("PromptEngine.buildChatPrompt", () => {
  it("puts the system prompt first and the user message last", () => {
    const out = engine.buildChatPrompt("hello", []);
    expect(out[0].role).toBe("system");
    expect(out[0].content).toBe(CHAT_SYSTEM_PROMPT);
    expect(out[out.length - 1]).toEqual({ role: "user", content: "hello" });
  });

  it("preserves conversation history in order between system and user", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
    ];
    const out = engine.buildChatPrompt("q2", history);
    expect(out).toEqual([
      { role: "system", content: CHAT_SYSTEM_PROMPT },
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
    ]);
  });

  it("injects current-file context into the system prompt", () => {
    const fc: FileContext = {
      filename: "src/auth.ts",
      languageId: "typescript",
      content: "export const x = 1;",
      cursorLine: 12,
    };
    const sys = engine.buildChatPrompt("explain this", [], fc)[0].content;
    expect(sys).toContain(CHAT_SYSTEM_PROMPT);
    expect(sys).toContain("src/auth.ts");
    expect(sys).toContain("typescript");
    expect(sys).toContain("export const x = 1;");
    expect(sys).toContain("line 12");
  });

  it("notes when the file is too large to include (no content)", () => {
    const fc: FileContext = { filename: "big.ts", languageId: "typescript" };
    const sys = engine.buildChatPrompt("hi", [], fc)[0].content;
    expect(sys).toContain("too large");
    expect(sys).not.toContain("```");
  });

  it("includes selected text when present", () => {
    const fc: FileContext = {
      filename: "a.ts",
      languageId: "typescript",
      content: "x",
      selectedText: "const y = 2;",
    };
    const sys = engine.buildChatPrompt("hi", [], fc)[0].content;
    expect(sys).toContain("selected");
    expect(sys).toContain("const y = 2;");
  });

  it("trims history to the most recent MAX_HISTORY_MESSAGES, keeping system + current", () => {
    const history: ChatMessage[] = Array.from(
      { length: MAX_HISTORY_MESSAGES + 6 },
      (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `m${i}`,
      }),
    );
    const out = engine.buildChatPrompt("now", history);
    // system + MAX_HISTORY_MESSAGES history + the current user message
    expect(out).toHaveLength(MAX_HISTORY_MESSAGES + 2);
    expect(out[0].role).toBe("system");
    expect(out[out.length - 1]).toEqual({ role: "user", content: "now" });
    // The oldest 6 messages were dropped; the kept window starts at m6.
    expect(out[1].content).toBe("m6");
  });
});

describe("PromptEngine.chatOptions", () => {
  it("returns the DATA_FLOW §3 sampling options", () => {
    expect(engine.chatOptions()).toEqual({
      temperature: CHAT_TEMPERATURE,
      top_p: CHAT_TOP_P,
    });
  });
});

describe("PromptEngine.buildFIMPrompt", () => {
  it("wraps prefix and suffix in plain Qwen FIM tokens ending at fim_middle", () => {
    const out = engine.buildFIMPrompt("const a = ", ";\n");
    expect(out).toBe("<|fim_prefix|>const a = <|fim_suffix|>;\n<|fim_middle|>");
  });

  it("ends with fim_middle so the model generates the gap next", () => {
    const out = engine.buildFIMPrompt("x", "y");
    expect(out.endsWith("<|fim_middle|>")).toBe(true);
  });

  it("orders the tokens prefix → suffix → middle", () => {
    const out = engine.buildFIMPrompt("PRE", "SUF");
    expect(out).toBe("<|fim_prefix|>PRE<|fim_suffix|>SUF<|fim_middle|>");
  });

  it("omits the filename — plain FIM avoids spurious markdown fences", () => {
    const out = engine.buildFIMPrompt("a", "b");
    expect(out).not.toContain("<|file_sep|>");
  });

  it("handles an empty suffix (cursor at end of file)", () => {
    const out = engine.buildFIMPrompt("end", "");
    expect(out).toBe("<|fim_prefix|>end<|fim_suffix|><|fim_middle|>");
  });
});

describe("PromptEngine.completionOptions", () => {
  it("returns the DATA_FLOW §1 sampling options", () => {
    expect(engine.completionOptions()).toEqual({
      temperature: COMPLETION_TEMPERATURE,
      top_p: COMPLETION_TOP_P,
      stop: COMPLETION_STOP,
    });
  });
});
