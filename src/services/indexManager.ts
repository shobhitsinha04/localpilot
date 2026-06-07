import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import * as path from "node:path";

import * as lancedb from "@lancedb/lancedb";
import * as lockfile from "proper-lockfile";

import {
  BINARY_FILE_EXTENSIONS,
  EMBED_MAX_CHARS,
  INDEX_FILE_BATCH_SIZE,
  MAX_INDEXABLE_FILE_BYTES,
  RECENCY_HALF_LIFE_MS,
  RERANK_RECENCY_WEIGHT,
  RERANK_SIMILARITY_WEIGHT,
  RERANK_TOP_K,
  SEARCH_TOP_K,
  SKIP_DIRS,
} from "../constants";
import type {
  CodeChunk,
  IndexProgress,
  IndexStats,
  Logger,
  RetrievedChunk,
} from "../types";
import { chunk as chunkFile } from "./chunker";
import { FileWalker } from "./fileWalker";
import type { OllamaService } from "./ollamaService";

// Owns the per-workspace LanceDB index: walks → chunks → embeds → stores, then
// searches + reranks on query (PHASES.md Phase 2, DATA_FLOW.md §5–6,
// DECISIONS 005). Bound to a single workspace; the index lives at
// `<storageDir>/index/<workspaceHash>/`. Stays free of `vscode` (the file
// watcher that drives updateFile/deleteFile is wired up in extension.ts).

/** LanceDB table name within each per-workspace database directory. */
const TABLE_NAME = "chunks";

/** A row as stored in LanceDB. */
interface ChunkRecord {
  vector: number[];
  text: string;
  filename: string;
  startLine: number;
  endLine: number;
  /** Source file mtime at index time — drives the recency rerank component. */
  mtimeMs: number;
}

/** Minimal shape the pure rerank needs from a LanceDB search row. */
export interface RerankRow {
  text: string;
  filename: string;
  startLine: number;
  endLine: number;
  mtimeMs: number;
  /** L2 distance from the query vector (smaller = closer). */
  _distance: number;
}

// ----------------------------------------------------------------------------
// Pure scoring (unit-tested directly)
// ----------------------------------------------------------------------------

/**
 * Map a LanceDB cosine distance (0 = identical, up to 2) to a 0–1 similarity.
 * Cosine is used rather than L2 because nomic embeddings are not normalised, so
 * raw L2 distances are large and collapse every similarity toward zero (found
 * via the live indexing harness).
 */
export function computeSimilarity(distance: number): number {
  return Math.min(1, Math.max(0, 1 - distance));
}

/** Exponential-decay recency in 0–1 from a file mtime (1 = just modified). */
export function computeRecency(mtimeMs: number, now: number): number {
  const age = Math.max(0, now - mtimeMs);
  return Math.pow(2, -age / RECENCY_HALF_LIFE_MS);
}

/**
 * Re-rank search candidates by 0.7×similarity + 0.3×recency and return the top
 * {@link RERANK_TOP_K} (DATA_FLOW.md §4). Pure: `now` is injectable so tests
 * are deterministic.
 */
export function rerank(
  rows: RerankRow[],
  now: number = Date.now(),
): RetrievedChunk[] {
  return rows
    .map((row) => {
      const similarity = computeSimilarity(row._distance);
      const recency = computeRecency(row.mtimeMs, now);
      const score =
        RERANK_SIMILARITY_WEIGHT * similarity + RERANK_RECENCY_WEIGHT * recency;
      return {
        filename: row.filename,
        startLine: row.startLine,
        endLine: row.endLine,
        text: row.text,
        similarity,
        recency,
        score,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, RERANK_TOP_K);
}

/** Quote a string for a LanceDB SQL predicate, escaping single quotes. */
function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// ----------------------------------------------------------------------------
// Index manager
// ----------------------------------------------------------------------------

export interface IndexManagerOptions {
  ollama: OllamaService;
  /** Extension global storage path (context.globalStorageUri.fsPath). */
  storageDir: string;
  /** Absolute path of the workspace this index covers. */
  workspacePath: string;
  embeddingModel: string;
  logger: Logger;
}

export class IndexManager {
  private readonly ollama: OllamaService;
  private readonly workspacePath: string;
  private readonly embeddingModel: string;
  private readonly logger: Logger;
  private readonly indexDir: string;
  readonly workspaceHash: string;

  private db?: lancedb.Connection;
  private table?: lancedb.Table;

  constructor(opts: IndexManagerOptions) {
    this.ollama = opts.ollama;
    this.workspacePath = opts.workspacePath;
    this.embeddingModel = opts.embeddingModel;
    this.logger = opts.logger;
    this.workspaceHash = createHash("sha256")
      .update(opts.workspacePath)
      .digest("hex")
      .slice(0, 16);
    this.indexDir = path.join(opts.storageDir, "index", this.workspaceHash);
  }

  /**
   * Walk, chunk, embed, and store every indexable file in the workspace.
   * Files are processed in batches of {@link INDEX_FILE_BATCH_SIZE}; writes are
   * guarded by a cross-process lock so two VS Code windows can't corrupt the
   * index (TECH_STACK.md proper-lockfile).
   */
  async indexWorkspace(
    onProgress?: (progress: IndexProgress) => void,
  ): Promise<IndexStats> {
    const release = await this.acquireLock();
    try {
      const files = await new FileWalker(this.logger).walk(this.workspacePath);
      let chunkCount = 0;
      let processed = 0;

      for (let i = 0; i < files.length; i += INDEX_FILE_BATCH_SIZE) {
        const batch = files.slice(i, i + INDEX_FILE_BATCH_SIZE);
        // Embed the batch concurrently, then insert serially (LanceDB table
        // creation/writes must not race).
        const built = await Promise.all(batch.map((f) => this.buildRecords(f)));
        for (const records of built) {
          if (records.length > 0) {
            await this.insert(records);
            chunkCount += records.length;
          }
        }
        processed += batch.length;
        onProgress?.({ current: processed, total: files.length });
      }

      this.logger.info(
        `Indexed ${files.length} files into ${chunkCount} chunks ` +
          `(workspace ${this.workspaceHash}).`,
      );
      return {
        fileCount: files.length,
        chunkCount,
        workspaceHash: this.workspaceHash,
      };
    } finally {
      await release();
    }
  }

  /** Embed `query` and return the reranked top {@link RERANK_TOP_K} chunks. */
  async search(query: string): Promise<RetrievedChunk[]> {
    const table = await this.openTable();
    if (!table) return [];
    const vector = await this.embed(query);
    if (vector.length === 0) return [];
    const rows = (await table
      .vectorSearch(vector)
      .distanceType("cosine")
      .limit(SEARCH_TOP_K)
      .toArray()) as RerankRow[];
    return rerank(rows);
  }

  /** Re-index a single file: drop its old chunks, then re-chunk and insert. */
  async updateFile(filePath: string): Promise<void> {
    if (!this.isIndexablePath(filePath)) return;
    const release = await this.acquireLock();
    try {
      await this.deleteChunksFor(filePath);
      const records = await this.buildRecords(filePath);
      if (records.length > 0) await this.insert(records);
    } finally {
      await release();
    }
  }

  /** Remove all chunks belonging to a deleted file. */
  async deleteFile(filePath: string): Promise<void> {
    const release = await this.acquireLock();
    try {
      await this.deleteChunksFor(filePath);
    } finally {
      await release();
    }
  }

  /** True if this workspace already has a non-empty index. */
  async isIndexed(): Promise<boolean> {
    try {
      const table = await this.openTable();
      return table ? (await table.countRows()) > 0 : false;
    } catch {
      return false;
    }
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  /** Read, chunk, and embed one file into LanceDB records (no write). */
  private async buildRecords(file: string): Promise<ChunkRecord[]> {
    let content: string;
    let mtimeMs: number;
    try {
      const info = await stat(file);
      if (info.size > MAX_INDEXABLE_FILE_BYTES) return [];
      mtimeMs = info.mtimeMs;
      content = await readFile(file, "utf8");
    } catch (err) {
      this.logger.warn(`Skipping ${file} during indexing: ${String(err)}`);
      return [];
    }

    const chunks = chunkFile(content, file);
    const records: ChunkRecord[] = [];
    for (const c of chunks) {
      const vector = await this.embed(c.text);
      if (vector.length > 0) records.push(this.toRecord(c, vector, mtimeMs));
    }
    return records;
  }

  private toRecord(
    chunk: CodeChunk,
    vector: number[],
    mtimeMs: number,
  ): ChunkRecord {
    return {
      vector,
      text: chunk.text,
      filename: chunk.filename,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      mtimeMs,
    };
  }

  /**
   * Embed text, returning [] (logged) on failure so indexing continues. Input
   * is truncated to {@link EMBED_MAX_CHARS} so a dense chunk can't exceed the
   * embedding model's context window.
   */
  private async embed(text: string): Promise<number[]> {
    const input =
      text.length > EMBED_MAX_CHARS ? text.slice(0, EMBED_MAX_CHARS) : text;
    try {
      return await this.ollama.embed(input, this.embeddingModel);
    } catch (err) {
      this.logger.warn(`Embedding failed: ${String(err)}`);
      return [];
    }
  }

  /** Insert records, creating the table from the first batch if needed. */
  private async insert(records: ChunkRecord[]): Promise<void> {
    // LanceDB types rows as Record<string, unknown>; ChunkRecord is exactly that
    // shape but lacks the index signature, so widen at the boundary.
    const rows = records as unknown as Record<string, unknown>[];
    const db = await this.connect();
    if (!(await db.tableNames()).includes(TABLE_NAME)) {
      this.table = await db.createTable(TABLE_NAME, rows);
    } else {
      const table = await this.openTable();
      await table?.add(rows);
    }
  }

  private async deleteChunksFor(filePath: string): Promise<void> {
    const table = await this.openTable();
    if (table) await table.delete(`filename = ${sqlString(filePath)}`);
  }

  private async connect(): Promise<lancedb.Connection> {
    if (!this.db) {
      await mkdir(this.indexDir, { recursive: true });
      this.db = await lancedb.connect(this.indexDir);
    }
    return this.db;
  }

  private async openTable(): Promise<lancedb.Table | null> {
    if (this.table) return this.table;
    const db = await this.connect();
    if (!(await db.tableNames()).includes(TABLE_NAME)) return null;
    this.table = await db.openTable(TABLE_NAME);
    return this.table;
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    // proper-lockfile defaults to realpath:true, which rejects with ENOENT if
    // the directory doesn't exist yet. Ensure it exists so an incremental
    // updateFile/deleteFile from the watcher works before any full index run.
    await mkdir(this.indexDir, { recursive: true });
    return lockfile.lock(this.indexDir, {
      stale: 30_000,
      retries: { retries: 10, factor: 1.5, minTimeout: 100, maxTimeout: 2_000 },
    });
  }

  /**
   * Mirror of FileWalker's skip rules for incremental updates: the VS Code
   * watcher fires for every path, but we only index source files. (.gitignore
   * is not re-checked here — a documented Builder simplification.)
   */
  private isIndexablePath(filePath: string): boolean {
    const rel = path.relative(this.workspacePath, filePath);
    // Outside the workspace: relative path escapes upward or onto another root.
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel))
      return false;
    if (rel.split(path.sep).some((seg) => SKIP_DIRS.has(seg))) return false;
    return !BINARY_FILE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
  }
}
