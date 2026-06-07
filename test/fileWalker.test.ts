import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FileWalker,
  hasBinaryExtension,
  isTooLarge,
  looksBinary,
  shouldSkipDir,
} from "../src/services/fileWalker";
import { MAX_INDEXABLE_FILE_BYTES } from "../src/constants";

describe("FileWalker pure predicates", () => {
  it("skips vendored/build directories", () => {
    expect(shouldSkipDir("node_modules")).toBe(true);
    expect(shouldSkipDir(".git")).toBe(true);
    expect(shouldSkipDir("__pycache__")).toBe(true);
    expect(shouldSkipDir("src")).toBe(false);
  });

  it("detects binary extensions case-insensitively", () => {
    expect(hasBinaryExtension("logo.PNG")).toBe(true);
    expect(hasBinaryExtension("app.dylib")).toBe(true);
    expect(hasBinaryExtension("main.ts")).toBe(false);
  });

  it("detects NUL bytes in a buffer head", () => {
    expect(looksBinary(Buffer.from("plain text"))).toBe(false);
    expect(looksBinary(Buffer.from([0x68, 0x00, 0x69]))).toBe(true);
  });

  it("flags files over the size limit", () => {
    expect(isTooLarge(MAX_INDEXABLE_FILE_BYTES + 1)).toBe(true);
    expect(isTooLarge(100)).toBe(false);
  });
});

describe("FileWalker.walk", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "localpilot-walk-"));
    // Indexable files.
    await writeFile(path.join(root, "keep.ts"), "export const a = 1;\n");
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "nested.ts"), "const b = 2;\n");
    // .gitignore excludes a file and a directory.
    await writeFile(path.join(root, ".gitignore"), "ignored.ts\nsecret/\n");
    await writeFile(path.join(root, "ignored.ts"), "secret\n");
    await mkdir(path.join(root, "secret"));
    await writeFile(path.join(root, "secret", "inner.ts"), "nope\n");
    // Skipped directories.
    await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(root, "node_modules", "pkg", "index.js"), "x\n");
    await mkdir(path.join(root, "dist"));
    await writeFile(path.join(root, "dist", "out.js"), "x\n");
    // Binary by extension and by content.
    await writeFile(path.join(root, "logo.png"), "x\n");
    await writeFile(
      path.join(root, "blob.ts"),
      Buffer.from([0x00, 0x01, 0x02]),
    );
    // Oversized file.
    await writeFile(
      path.join(root, "big.ts"),
      "a".repeat(MAX_INDEXABLE_FILE_BYTES + 10),
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns only indexable files (text dotfiles like .gitignore included)", async () => {
    const found = (await new FileWalker().walk(root))
      .map((f) => path.relative(root, f).split(path.sep).join("/"))
      .sort();
    // .gitignore is a plain text file matching none of the skip rules, so it is
    // indexed; the excluded set is verified in the next test.
    expect(found).toEqual([".gitignore", "keep.ts", "src/nested.ts"]);
  });

  it("excludes gitignored, vendored, binary, and oversized files", async () => {
    const found = (await new FileWalker().walk(root)).map((f) =>
      path.basename(f),
    );
    for (const excluded of [
      "ignored.ts",
      "inner.ts",
      "index.js",
      "out.js",
      "logo.png",
      "blob.ts",
      "big.ts",
    ]) {
      expect(found).not.toContain(excluded);
    }
  });
});
