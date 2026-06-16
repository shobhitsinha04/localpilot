// Line-level diff for the CMD+K rewrite view (PHASES.md Phase 5, DATA_FLOW.md
// §2). Pure and `vscode`-free so it is unit-tested directly; the CmdKController
// turns the rows into red/green editor decorations. This is display-only — the
// exact original text is kept verbatim for a clean Reject, so the diff never has
// to be reversible.

export type DiffRowType = "context" | "removed" | "added";

export interface DiffRow {
  type: DiffRowType;
  /** The line's text (without its trailing newline). */
  text: string;
}

function splitLines(text: string): string[] {
  // Normalise CRLF so a difference in line endings alone is not shown as a change.
  return text.replace(/\r\n/g, "\n").split("\n");
}

/**
 * Compute a line diff between `original` and `updated` via a longest-common-
 * subsequence walk. Unchanged lines are `context`, lines only in `original` are
 * `removed`, lines only in `updated` are `added`. Order follows the new text:
 * a removed line is emitted just before the added line(s) that replace it.
 */
export function diffLines(original: string, updated: string): DiffRow[] {
  const a = splitLines(original);
  const b = splitLines(updated);
  const m = a.length;
  const n = b.length;

  // lcs[i][j] = length of the LCS of a[i..] and b[j..].
  const lcs: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i][j] =
        a[i] === b[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      rows.push({ type: "context", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      rows.push({ type: "removed", text: a[i] });
      i++;
    } else {
      rows.push({ type: "added", text: b[j] });
      j++;
    }
  }
  while (i < m) rows.push({ type: "removed", text: a[i++] });
  while (j < n) rows.push({ type: "added", text: b[j++] });
  return rows;
}
