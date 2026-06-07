import { describe, expect, it } from "vitest";

import { chunk } from "../src/services/chunker";

/** Build `n` numbered lines ("line1\nline2\n...") with no trailing newline. */
function lines(n: number): string {
  return Array.from({ length: n }, (_, i) => `line${i + 1}`).join("\n");
}

describe("chunk", () => {
  it("returns no chunks for empty content", () => {
    expect(chunk("", "a.ts")).toEqual([]);
  });

  it("returns a single chunk for a short file", () => {
    const result = chunk(lines(10), "a.ts");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      startLine: 1,
      endLine: 10,
      filename: "a.ts",
    });
  });

  it("returns one chunk for a file exactly at the window size", () => {
    const result = chunk(lines(150), "a.ts");
    expect(result).toHaveLength(1);
    expect(result[0].startLine).toBe(1);
    expect(result[0].endLine).toBe(150);
  });

  it("splits into overlapping chunks past the window boundary", () => {
    const result = chunk(lines(151), "a.ts");
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ startLine: 1, endLine: 150 });
    // Second chunk starts 130 lines on (150 window − 20 overlap).
    expect(result[1]).toMatchObject({ startLine: 131, endLine: 151 });
  });

  it("overlaps adjacent chunks by exactly the overlap size", () => {
    const result = chunk(lines(400), "a.ts");
    // Each chunk after the first starts 130 lines after the previous start.
    expect(result[0].startLine).toBe(1);
    expect(result[1].startLine).toBe(131);
    expect(result[2].startLine).toBe(261);
    // Overlap: chunk[1] covers 131..280, chunk[0] covers 1..150 → 131..150 shared.
    expect(result[0].endLine - result[1].startLine + 1).toBe(20);
  });

  it("counts a file-final newline as terminating, not a new line", () => {
    const result = chunk("a\nb\n", "a.ts");
    expect(result).toHaveLength(1);
    expect(result[0].endLine).toBe(2);
    expect(result[0].text).toBe("a\nb");
  });

  it("drops whitespace-only chunks", () => {
    expect(chunk("\n\n\n   \n", "a.ts")).toEqual([]);
  });

  it("tags every chunk with the filename", () => {
    const result = chunk(lines(300), "src/foo.ts");
    expect(result.every((c) => c.filename === "src/foo.ts")).toBe(true);
  });
});
