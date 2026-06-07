import { CHUNK_OVERLAP_LINES, CHUNK_SIZE_LINES } from "../constants";
import type { CodeChunk } from "../types";

// Splits a file into overlapping line windows so that a construct straddling a
// chunk boundary still appears intact in at least one chunk (DATA_FLOW.md §5).
// Pure and side-effect free — unit-tested directly.

/** Lines advanced between successive chunk starts (window minus overlap). */
const STRIDE = CHUNK_SIZE_LINES - CHUNK_OVERLAP_LINES;

/**
 * Split `content` into overlapping {@link CodeChunk}s of up to
 * {@link CHUNK_SIZE_LINES} lines with {@link CHUNK_OVERLAP_LINES} of overlap.
 * Line numbers are 1-based and inclusive. Whitespace-only chunks are dropped.
 */
export function chunk(content: string, filename: string): CodeChunk[] {
  if (content.length === 0) return [];

  // Drop a single trailing empty line produced by a file-final newline so line
  // counts match what an editor shows.
  const raw = content.split("\n");
  const lines =
    raw.length > 1 && raw[raw.length - 1] === "" ? raw.slice(0, -1) : raw;
  const total = lines.length;

  const chunks: CodeChunk[] = [];
  for (let start = 0; start < total; start += STRIDE) {
    const end = Math.min(start + CHUNK_SIZE_LINES, total);
    const text = lines.slice(start, end).join("\n");
    if (text.trim().length > 0) {
      chunks.push({
        filename,
        startLine: start + 1,
        endLine: end,
        text,
      });
    }
    // The window already reached the end of the file; a further (purely
    // overlapping) chunk would add nothing.
    if (end === total) break;
  }
  return chunks;
}
