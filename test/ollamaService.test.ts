import { describe, expect, it } from "vitest";

import {
  OllamaError,
  parsePullProgressLine,
  parseStreamLine,
  summariseStderr,
} from "../src/services/ollamaService";

describe("parsePullProgressLine", () => {
  it("returns null for blank lines", () => {
    expect(parsePullProgressLine("")).toBeNull();
    expect(parsePullProgressLine("   ")).toBeNull();
  });

  it("parses a status line with no percentage", () => {
    expect(parsePullProgressLine("pulling manifest")).toEqual({
      status: "pulling manifest",
      percent: undefined,
    });
  });

  it("extracts the percentage and leading status", () => {
    const line = "pulling 8eeb52dfb3bb... 47% ▕███   ▏ 2.2 GB/4.7 GB";
    expect(parsePullProgressLine(line)).toEqual({
      status: "pulling 8eeb52dfb3bb...",
      percent: 47,
    });
  });

  it("clamps percentages to 100", () => {
    expect(parsePullProgressLine("downloading 100%")?.percent).toBe(100);
  });

  it("treats 'success' as a status with no percent", () => {
    expect(parsePullProgressLine("success")).toEqual({
      status: "success",
      percent: undefined,
    });
  });
});

describe("parseStreamLine", () => {
  it("extracts a chat token from message.content", () => {
    const line = JSON.stringify({ message: { content: "Hello" }, done: false });
    expect(parseStreamLine(line, "chat")).toEqual({
      token: "Hello",
      done: false,
    });
  });

  it("extracts a generate token from response", () => {
    const line = JSON.stringify({ response: "world", done: false });
    expect(parseStreamLine(line, "generate")).toEqual({
      token: "world",
      done: false,
    });
  });

  it("reports the done flag on the final chunk", () => {
    const line = JSON.stringify({ message: { content: "" }, done: true });
    expect(parseStreamLine(line, "chat")).toEqual({ token: "", done: true });
  });

  it("falls back to an empty token when the chat field is absent", () => {
    // Ollama's final chat chunk can be {"done":true} with no message field.
    const line = JSON.stringify({ done: true });
    expect(parseStreamLine(line, "chat")).toEqual({ token: "", done: true });
  });

  it("falls back to an empty token when the generate field is absent", () => {
    const line = JSON.stringify({ done: true });
    expect(parseStreamLine(line, "generate")).toEqual({
      token: "",
      done: true,
    });
  });

  it("throws OllamaError when the chunk carries an error", () => {
    const line = JSON.stringify({ error: "model not found" });
    expect(() => parseStreamLine(line, "chat")).toThrow(OllamaError);
  });
});

describe("summariseStderr", () => {
  it("returns an empty string for empty input", () => {
    expect(summariseStderr("")).toBe("");
    expect(summariseStderr("   \n  ")).toBe("");
  });

  it("prefers the last line mentioning an error", () => {
    const raw =
      "pulling manifest\n" +
      "pulling 8eeb52dfb3bb... 100%\n" +
      "Error: max retries exceeded: context deadline exceeded\n";
    expect(summariseStderr(raw)).toBe(
      "Error: max retries exceeded: context deadline exceeded",
    );
  });

  it("strips ANSI escape codes and progress redraws", () => {
    const raw =
      "pulling 832dd9e00a68: 100% [?25l[1G[K\r" + "Error: something broke[0m";
    expect(summariseStderr(raw)).toBe("Error: something broke");
  });

  it("falls back to the last non-empty line when no error line exists", () => {
    expect(summariseStderr("pulling manifest\nverifying digest\n")).toBe(
      "verifying digest",
    );
  });
});
