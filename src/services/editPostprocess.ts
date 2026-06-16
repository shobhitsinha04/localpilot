// Clean a CMD+K rewrite before it is inserted into the document (PHASES.md
// Phase 5). Pure and `vscode`-free so it is unit-tested directly. The
// EDIT_SYSTEM_PROMPT already asks for "no markdown fences", but small instruct
// models wrap their answer in a ```lang … ``` block anyway (confirmed against
// Ollama), and those fence lines must not land in the file.
//
// Written to be safe on a partial buffer so the CmdKController can call it on
// every streamed token for a clean live preview: a leading fence is stripped as
// soon as it appears, and the trailing fence is stripped once it arrives.

/** Strip a surrounding ```lang … ``` block and trailing whitespace. */
export function cleanEditOutput(raw: string): string {
  const lines = raw.split("\n");
  if (lines.length > 0 && /^```[a-zA-Z0-9+#-]*$/.test(lines[0].trim())) {
    lines.shift();
  }
  if (lines.length > 0 && lines[lines.length - 1].trim() === "```") {
    lines.pop();
  }
  return lines.join("\n").replace(/\s+$/, "");
}
