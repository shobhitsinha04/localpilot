import { describe, expect, it } from "vitest";

import { cleanCompletion } from "../src/services/completionPostprocess";

describe("cleanCompletion", () => {
  it("passes clean code through unchanged (minus trailing whitespace)", () => {
    expect(cleanCompletion("a + b;", "")).toBe("a + b;");
  });

  it("preserves leading indentation", () => {
    expect(cleanCompletion("    return x;", "")).toBe("    return x;");
  });

  it("strips echoed FIM / chat special tokens", () => {
    expect(cleanCompletion("a + b;<|endoftext|>", "")).toBe("a + b;");
    expect(cleanCompletion("<|fim_middle|>foo()", "")).toBe("foo()");
    expect(cleanCompletion("x<|im_end|>", "")).toBe("x");
  });

  it("unwraps a markdown-fenced code block", () => {
    const raw = "```typescript\nfunction add() {\n  return 1;\n}\n```";
    expect(cleanCompletion(raw, "")).toBe("function add() {\n  return 1;\n}");
  });

  it("strips a stray trailing fence with no opening fence", () => {
    expect(cleanCompletion('"Hi " + u.Name\n}\n```', "")).toBe(
      '"Hi " + u.Name\n}',
    );
  });

  it("trims a tail that repeats the start of the suffix", () => {
    // Suffix already has the closing `;` — don't duplicate it.
    expect(cleanCompletion("map(n => n * 2);", ";\nconsole.log(x);")).toBe(
      "map(n => n * 2)",
    );
  });

  it("trims a duplicated closing brace the suffix provides", () => {
    expect(cleanCompletion('"Hello, " + u.Name\n}', "\n}")).toBe(
      '"Hello, " + u.Name',
    );
  });

  it("leaves text alone when there is no suffix overlap", () => {
    expect(cleanCompletion("a + b", ";\n")).toBe("a + b");
  });

  it("returns empty string for whitespace-only output", () => {
    expect(cleanCompletion("   \n\t", "")).toBe("");
    expect(cleanCompletion("", "")).toBe("");
  });

  it("returns empty string when output is only special tokens", () => {
    expect(cleanCompletion("<|fim_middle|><|endoftext|>", "")).toBe("");
  });
});
