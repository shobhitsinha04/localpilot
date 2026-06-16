import { describe, expect, it } from "vitest";

import { cleanEditOutput } from "../src/services/editPostprocess";

describe("cleanEditOutput", () => {
  it("leaves clean code unchanged (minus trailing whitespace)", () => {
    expect(cleanEditOutput("const a = 1;")).toBe("const a = 1;");
  });

  it("strips a surrounding ```lang fence block", () => {
    const raw = "```typescript\nfunction f() {\n  return 1;\n}\n```";
    expect(cleanEditOutput(raw)).toBe("function f() {\n  return 1;\n}");
  });

  it("strips a bare ``` fence with no language", () => {
    expect(cleanEditOutput("```\nx = 1\n```")).toBe("x = 1");
  });

  it("preserves internal indentation and blank lines", () => {
    const raw = "```js\nif (x) {\n\n  y();\n}\n```";
    expect(cleanEditOutput(raw)).toBe("if (x) {\n\n  y();\n}");
  });

  it("is safe on a partial buffer with only the opening fence (live preview)", () => {
    expect(cleanEditOutput("```typescript\nfunction f(")).toBe("function f(");
  });

  it("does not strip a triple-backtick that is not a whole-line fence", () => {
    expect(cleanEditOutput("const s = `a```b`;")).toBe("const s = `a```b`;");
  });

  it("returns empty string when only an opening fence has streamed so far", () => {
    expect(cleanEditOutput("```js\n")).toBe("");
  });
});
