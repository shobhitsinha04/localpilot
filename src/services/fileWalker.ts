import { readdir, readFile, stat } from "node:fs/promises";
import * as path from "node:path";

import ignore, { type Ignore } from "ignore";

import {
  BINARY_FILE_EXTENSIONS,
  MAX_INDEXABLE_FILE_BYTES,
  NULL_BYTE_SNIFF_BYTES,
  SKIP_DIRS,
} from "../constants";
import type { Logger } from "../types";

// Walks a workspace and returns the absolute paths worth indexing, skipping
// vendored/build dirs, .gitignored paths, binaries, and oversized files
// (DATA_FLOW.md §5). I/O is isolated here; the predicates below are pure and
// unit-tested directly.

// ----------------------------------------------------------------------------
// Pure predicates
// ----------------------------------------------------------------------------

/** True for directories we never descend into (node_modules, .git, …). */
export function shouldSkipDir(name: string): boolean {
  return SKIP_DIRS.has(name);
}

/** True when a filename's extension is on the known-binary list. */
export function hasBinaryExtension(filename: string): boolean {
  return BINARY_FILE_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

/** True when the head of a buffer contains a NUL byte (binary content). */
export function looksBinary(buffer: Buffer): boolean {
  const len = Math.min(buffer.length, NULL_BYTE_SNIFF_BYTES);
  for (let i = 0; i < len; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

/** True when a file's size exceeds the indexable limit. */
export function isTooLarge(bytes: number): boolean {
  return bytes > MAX_INDEXABLE_FILE_BYTES;
}

// ----------------------------------------------------------------------------
// Walker
// ----------------------------------------------------------------------------

export class FileWalker {
  constructor(private readonly logger?: Logger) {}

  /** Recursively collect indexable file paths under `workspacePath`. */
  async walk(workspacePath: string): Promise<string[]> {
    const ig = await this.loadGitignore(workspacePath);
    const out: string[] = [];
    await this.walkDir(workspacePath, workspacePath, ig, out);
    return out;
  }

  /** Load the workspace-root .gitignore into a matcher (empty if absent). */
  private async loadGitignore(root: string): Promise<Ignore> {
    const ig = ignore();
    try {
      ig.add(await readFile(path.join(root, ".gitignore"), "utf8"));
    } catch {
      // No .gitignore (or unreadable) — nothing to add.
    }
    return ig;
  }

  private async walkDir(
    dir: string,
    root: string,
    ig: Ignore,
    out: string[],
  ): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      this.logger?.warn(`Skipping unreadable directory ${dir}: ${String(err)}`);
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      // `ignore` expects paths relative to the gitignore location, using "/".
      const rel = path.relative(root, full).split(path.sep).join("/");

      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name)) continue;
        if (rel && ig.ignores(`${rel}/`)) continue;
        await this.walkDir(full, root, ig, out);
      } else if (entry.isFile()) {
        if (rel && ig.ignores(rel)) continue;
        if (hasBinaryExtension(entry.name)) continue;
        if (await this.isIndexableContent(full)) out.push(full);
      }
    }
  }

  /** Size + null-byte gate on a file's actual bytes. */
  private async isIndexableContent(file: string): Promise<boolean> {
    try {
      if (isTooLarge((await stat(file)).size)) return false;
      return !looksBinary(await readFile(file));
    } catch (err) {
      this.logger?.warn(`Skipping unreadable file ${file}: ${String(err)}`);
      return false;
    }
  }
}
