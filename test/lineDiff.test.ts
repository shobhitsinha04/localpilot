import { describe, expect, it } from "vitest";

import { diffLines, type DiffRow } from "../src/services/lineDiff";

const types = (rows: DiffRow[]): string[] => rows.map((r) => r.type);
const texts = (rows: DiffRow[], type: string): string[] =>
  rows.filter((r) => r.type === type).map((r) => r.text);

describe("diffLines", () => {
  it("marks every line as context when the text is unchanged", () => {
    const rows = diffLines("a\nb\nc", "a\nb\nc");
    expect(types(rows)).toEqual(["context", "context", "context"]);
  });

  it("marks a full replacement as all removed then all added", () => {
    const rows = diffLines("old1\nold2", "new1\nnew2");
    expect(texts(rows, "removed")).toEqual(["old1", "old2"]);
    expect(texts(rows, "added")).toEqual(["new1", "new2"]);
    expect(types(rows)).not.toContain("context");
  });

  it("detects a single changed line, keeping surrounding context", () => {
    const rows = diffLines("a\nb\nc", "a\nB\nc");
    expect(texts(rows, "context")).toEqual(["a", "c"]);
    expect(texts(rows, "removed")).toEqual(["b"]);
    expect(texts(rows, "added")).toEqual(["B"]);
  });

  it("detects a pure insertion", () => {
    const rows = diffLines("a\nc", "a\nb\nc");
    expect(texts(rows, "added")).toEqual(["b"]);
    expect(texts(rows, "removed")).toEqual([]);
    expect(texts(rows, "context")).toEqual(["a", "c"]);
  });

  it("detects a pure deletion", () => {
    const rows = diffLines("a\nb\nc", "a\nc");
    expect(texts(rows, "removed")).toEqual(["b"]);
    expect(texts(rows, "added")).toEqual([]);
    expect(texts(rows, "context")).toEqual(["a", "c"]);
  });

  it("treats a CRLF-only difference as no change", () => {
    const rows = diffLines("a\r\nb", "a\nb");
    expect(types(rows)).toEqual(["context", "context"]);
  });

  it("emits all-added when the original is empty-ish vs new content", () => {
    const rows = diffLines("", "x\ny");
    // "" splits to a single empty line; it stays as context, then x/y are added.
    expect(texts(rows, "added")).toEqual(["x", "y"]);
  });

  it("emits all-removed when everything is deleted", () => {
    const rows = diffLines("x\ny", "");
    expect(texts(rows, "removed")).toEqual(["x", "y"]);
  });

  it("reconstructs the new text from context+added rows in order", () => {
    const rows = diffLines(
      "function f() {\n  return 1;\n}",
      "function f() {\n  return 2;\n}",
    );
    const rebuilt = rows
      .filter((r) => r.type !== "removed")
      .map((r) => r.text)
      .join("\n");
    expect(rebuilt).toBe("function f() {\n  return 2;\n}");
  });
});
