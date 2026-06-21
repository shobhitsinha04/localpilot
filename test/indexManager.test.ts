import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import * as lancedb from "@lancedb/lancedb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MAX_INDEXABLE_FILE_BYTES,
  RECENCY_HALF_LIFE_MS,
  RERANK_TOP_K,
} from "../src/constants";
import {
  computeRecency,
  computeSimilarity,
  IndexManager,
  rerank,
  type RerankRow,
} from "../src/services/indexManager";
import type { OllamaService } from "../src/services/ollamaService";
import type { Logger } from "../src/types";

function row(partial: Partial<RerankRow>): RerankRow {
  return {
    text: "t",
    filename: "f.ts",
    startLine: 1,
    endLine: 10,
    mtimeMs: 0,
    _distance: 0,
    ...partial,
  };
}

describe("computeSimilarity", () => {
  it("maps cosine distance 0 (identical) to similarity 1", () => {
    expect(computeSimilarity(0)).toBe(1);
  });

  it("decreases as cosine distance grows", () => {
    expect(computeSimilarity(0.4)).toBeCloseTo(0.6, 10);
    expect(computeSimilarity(0.8)).toBeLessThan(computeSimilarity(0.4));
  });

  it("clamps an opposite vector (distance ≥ 1) to 0", () => {
    expect(computeSimilarity(1)).toBe(0);
    expect(computeSimilarity(2)).toBe(0);
  });

  it("clamps a negative distance to 1", () => {
    expect(computeSimilarity(-0.2)).toBe(1);
  });
});

describe("computeRecency", () => {
  const now = 1_000_000_000_000;

  it("scores a just-modified file at 1", () => {
    expect(computeRecency(now, now)).toBe(1);
  });

  it("scores a file one half-life old at 0.5", () => {
    expect(computeRecency(now - RECENCY_HALF_LIFE_MS, now)).toBeCloseTo(
      0.5,
      10,
    );
  });

  it("never exceeds 1 for future mtimes", () => {
    expect(computeRecency(now + RECENCY_HALF_LIFE_MS, now)).toBe(1);
  });
});

describe("rerank", () => {
  const now = 1_000_000_000_000;

  it("orders by combined similarity + recency, highest first", () => {
    const rows = [
      row({ filename: "far-recent.ts", _distance: 0.9, mtimeMs: now }),
      row({ filename: "close-old.ts", _distance: 0, mtimeMs: 0 }),
    ];
    const out = rerank(rows, now);
    // close-old: 0.7*1 + 0.3*~0 ≈ 0.70; far-recent: 0.7*0.1 + 0.3*1 = 0.37.
    expect(out[0].filename).toBe("close-old.ts");
  });

  it("lets strong recency override a weaker similarity", () => {
    const rows = [
      row({ filename: "a.ts", _distance: 0.2, mtimeMs: 0 }),
      row({ filename: "b.ts", _distance: 0.5, mtimeMs: now }),
    ];
    const out = rerank(rows, now);
    // a: 0.7*0.8 + 0 = 0.56; b: 0.7*0.5 + 0.3*1 = 0.65.
    expect(out[0].filename).toBe("b.ts");
  });

  it(`returns at most ${RERANK_TOP_K} chunks`, () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      row({ filename: `f${i}.ts`, _distance: i * 0.05 }),
    );
    expect(rerank(rows, now)).toHaveLength(RERANK_TOP_K);
  });

  it("populates similarity, recency, and combined score on each result", () => {
    const out = rerank([row({ _distance: 0.4, mtimeMs: now })], now);
    expect(out[0].similarity).toBeCloseTo(0.6, 10);
    expect(out[0].recency).toBe(1);
    expect(out[0].score).toBeCloseTo(0.7 * 0.6 + 0.3 * 1, 10);
  });
});

// ----------------------------------------------------------------------------
// IndexManager integration (real LanceDB + temp filesystem, fake embedder)
//
// These exercise the storage path the duplicate-chunk fix lives in:
// indexWorkspace's drop-then-rebuild idempotency and reconcile's mtime diff.
// The embedder is a deterministic stub (no Ollama needed) that counts calls so
// we can assert *which* files were re-embedded.
// ----------------------------------------------------------------------------

const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Deterministic non-zero vector from text, so identical text → identical row. */
function fakeVector(text: string): number[] {
  const v = new Array<number>(8).fill(0.01);
  for (let i = 0; i < text.length; i++) {
    v[i % 8] += (text.charCodeAt(i) % 13) / 13;
  }
  return v;
}

/** A stub OllamaService exposing only embed(), tracking how many times it ran. */
function makeEmbedder(): { ollama: OllamaService; calls: () => number } {
  let calls = 0;
  const ollama = {
    embed: (text: string): Promise<number[]> => {
      calls += 1;
      return Promise.resolve(fakeVector(text));
    },
  };
  return { ollama: ollama as unknown as OllamaService, calls: () => calls };
}

interface StoredRow {
  filename: string;
  startLine: number;
  endLine: number;
  text: string;
  mtimeMs: number;
}

describe("IndexManager storage (indexWorkspace + reconcile)", () => {
  let workspace: string;
  let storageDir: string;
  let embedder: ReturnType<typeof makeEmbedder>;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), "lp-ws-"));
    storageDir = await mkdtemp(path.join(tmpdir(), "lp-store-"));
    embedder = makeEmbedder();
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
    await rm(storageDir, { recursive: true, force: true });
  });

  /** Fresh manager bound to the temp workspace — mimics a new activation. */
  function newManager(): IndexManager {
    return new IndexManager({
      ollama: embedder.ollama,
      storageDir,
      workspacePath: workspace,
      embeddingModel: "fake",
      logger: silentLogger,
    });
  }

  /** Write a small (single-chunk) source file into the workspace. */
  async function writeFileIn(name: string, body: string): Promise<string> {
    const full = path.join(workspace, name);
    await writeFile(full, body, "utf8");
    return full;
  }

  /** Read every stored row straight from LanceDB, independent of the manager. */
  async function readRows(hash: string): Promise<StoredRow[]> {
    const indexDir = path.join(storageDir, "index", hash);
    const db = await lancedb.connect(indexDir);
    if (!(await db.tableNames()).includes("chunks")) return [];
    const table = await db.openTable("chunks");
    return (await table
      .query()
      .select(["filename", "startLine", "endLine", "text", "mtimeMs"])
      .toArray()) as StoredRow[];
  }

  /** Set of basenames present in the index (files dedupe nicely by name here). */
  function names(rows: StoredRow[]): string[] {
    return [...new Set(rows.map((r) => path.basename(r.filename)))].sort();
  }

  /** True if any (file, startLine, endLine) triple appears more than once. */
  function hasDuplicateChunks(rows: StoredRow[]): boolean {
    const seen = new Set<string>();
    for (const r of rows) {
      const key = `${r.filename}:${r.startLine}-${r.endLine}`;
      if (seen.has(key)) return true;
      seen.add(key);
    }
    return false;
  }

  // --- A. indexWorkspace idempotency (the duplicate-chunk regression) --------

  it("A1: indexing twice does not stack duplicate copies", async () => {
    await writeFileIn("a.ts", "export const a = 1;\n");
    await writeFileIn("b.ts", "export const b = 2;\n");

    const first = newManager();
    const stats1 = await first.indexWorkspace();
    const rows1 = await readRows(first.workspaceHash);
    expect(rows1.length).toBe(stats1.chunkCount);
    expect(rows1.length).toBeGreaterThan(0);

    // A fresh manager mimics a second activation on the same workspace.
    const second = newManager();
    await second.indexWorkspace();
    const rows2 = await readRows(second.workspaceHash);

    expect(rows2.length).toBe(rows1.length); // not doubled
    expect(hasDuplicateChunks(rows2)).toBe(false);
  });

  it("A3: re-indexing reflects a deleted file (rebuild, not append)", async () => {
    await writeFileIn("a.ts", "export const a = 1;\n");
    const bPath = await writeFileIn("b.ts", "export const b = 2;\n");

    const m1 = newManager();
    await m1.indexWorkspace();
    expect(names(await readRows(m1.workspaceHash))).toEqual(["a.ts", "b.ts"]);

    await rm(bPath);
    const m2 = newManager();
    await m2.indexWorkspace();
    expect(names(await readRows(m2.workspaceHash))).toEqual(["a.ts"]);
  });

  // --- B. reconcile incremental diff ----------------------------------------

  it("B4: reconcile on an empty index indexes everything", async () => {
    await writeFileIn("a.ts", "export const a = 1;\n");
    await writeFileIn("b.ts", "export const b = 2;\n");

    const m = newManager();
    const stats = await m.reconcile();
    const rows = await readRows(m.workspaceHash);

    expect(stats.chunkCount).toBeGreaterThan(0);
    expect(names(rows)).toEqual(["a.ts", "b.ts"]);
  });

  it("B5: reconcile on an unchanged workspace re-embeds nothing", async () => {
    await writeFileIn("a.ts", "export const a = 1;\n");
    await writeFileIn("b.ts", "export const b = 2;\n");

    const m1 = newManager();
    await m1.reconcile();
    const before = await readRows(m1.workspaceHash);

    const callsAfterFirst = embedder.calls();
    const m2 = newManager();
    await m2.reconcile();
    const after = await readRows(m2.workspaceHash);

    expect(embedder.calls()).toBe(callsAfterFirst); // zero new embeds
    expect(after.length).toBe(before.length);
    expect(hasDuplicateChunks(after)).toBe(false);
  });

  it("B6: editing a file re-embeds only that file", async () => {
    const aPath = await writeFileIn("a.ts", "export const a = 1;\n");
    await writeFileIn("b.ts", "export const b = 2;\n");

    const m1 = newManager();
    await m1.reconcile();
    const baseline = embedder.calls();

    // Change content and force a distinct (future) mtime.
    await writeFile(aPath, "export const a = 999;\n", "utf8");
    const future = new Date(Date.now() + 60_000);
    await utimes(aPath, future, future);

    const m2 = newManager();
    await m2.reconcile();
    const rows = await readRows(m2.workspaceHash);

    expect(embedder.calls() - baseline).toBe(1); // only a.ts (single chunk)
    const aRow = rows.find((r) => path.basename(r.filename) === "a.ts");
    expect(aRow?.text).toContain("999");
    expect(hasDuplicateChunks(rows)).toBe(false);
  });

  it("B7: a newly added file is picked up by reconcile", async () => {
    await writeFileIn("a.ts", "export const a = 1;\n");

    const m1 = newManager();
    await m1.reconcile();
    const baseline = embedder.calls();

    await writeFileIn("c.ts", "export const c = 3;\n");
    const m2 = newManager();
    await m2.reconcile();

    expect(embedder.calls() - baseline).toBe(1); // only the new file
    expect(names(await readRows(m2.workspaceHash))).toEqual(["a.ts", "c.ts"]);
  });

  it("B8: a file deleted while inactive is purged by reconcile", async () => {
    await writeFileIn("a.ts", "export const a = 1;\n");
    const bPath = await writeFileIn("b.ts", "export const b = 2;\n");

    const m1 = newManager();
    await m1.reconcile();
    expect(names(await readRows(m1.workspaceHash))).toEqual(["a.ts", "b.ts"]);

    await rm(bPath); // simulate an offline deletion the watcher never saw
    const m2 = newManager();
    await m2.reconcile();
    expect(names(await readRows(m2.workspaceHash))).toEqual(["a.ts"]);
  });

  it("B9: an mtime moved backwards still triggers a re-index", async () => {
    const aPath = await writeFileIn("a.ts", "export const a = 1;\n");

    const m1 = newManager();
    await m1.reconcile();
    const baseline = embedder.calls();

    // A checkout/restore can set an *older* mtime — a `> stored` check would
    // miss this; the implementation uses `!==`.
    await writeFile(aPath, "export const a = 42;\n", "utf8");
    const past = new Date("2001-01-01T00:00:00Z");
    await utimes(aPath, past, past);

    const m2 = newManager();
    await m2.reconcile();
    const rows = await readRows(m2.workspaceHash);

    expect(embedder.calls() - baseline).toBe(1);
    const aRow = rows.find((r) => path.basename(r.filename) === "a.ts");
    expect(aRow?.text).toContain("42");
  });

  // --- C. helper behavior, observed through the public API ------------------

  it("B10/C: a file over the size limit is excluded and never retried", async () => {
    await writeFileIn("a.ts", "export const a = 1;\n");
    const big = "// big\n" + "x".repeat(MAX_INDEXABLE_FILE_BYTES + 1024);
    await writeFileIn("big.ts", big);

    const m1 = newManager();
    await m1.reconcile();
    expect(names(await readRows(m1.workspaceHash))).toEqual(["a.ts"]);

    // Second pass must not keep retrying the oversized file (scan size-guards it).
    const baseline = embedder.calls();
    const m2 = newManager();
    await m2.reconcile();
    expect(embedder.calls()).toBe(baseline);
    expect(names(await readRows(m2.workspaceHash))).toEqual(["a.ts"]);
  });

  it("a primed reader sees a writer's updateFile (cross-handle consistency)", async () => {
    await writeFileIn("a.ts", "export const alpha = 1;\n");
    const writer = newManager();
    await writer.indexWorkspace();

    // Reader opens + caches its table handle by searching once (old version).
    const reader = newManager();
    const before = await reader.search("anything");
    expect(before.some((h) => h.text.includes("alpha"))).toBe(true);

    // A different handle updates the file.
    await writeFileIn("a.ts", "export const beta = 2;\n");
    await writer.updateFile(path.join(workspace, "a.ts"));

    // The reader must now see the new content, not its stale snapshot.
    const after = await reader.search("anything");
    expect(after.some((h) => h.text.includes("beta"))).toBe(true);
    expect(after.some((h) => h.text.includes("alpha"))).toBe(false);
  });

  it("search() reflects updateFile() on the same long-lived manager", async () => {
    await writeFileIn("a.ts", "export const alpha = 1;\n");
    const m = newManager();
    await m.indexWorkspace();

    const before = await m.search("anything");
    expect(before.some((h) => h.text.includes("alpha"))).toBe(true);

    // Edit the file and push the update through the SAME manager, as a save does.
    await writeFileIn("a.ts", "export const beta = 2;\n");
    await m.updateFile(path.join(workspace, "a.ts"));

    const after = await m.search("anything");
    expect(after.some((h) => h.text.includes("beta"))).toBe(true);
    expect(after.some((h) => h.text.includes("alpha"))).toBe(false);
  });
});
