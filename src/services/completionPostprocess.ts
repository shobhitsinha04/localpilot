// Clean a raw model completion into ghost text fit to insert (DATA_FLOW.md §1).
// Pure and `vscode`-free so it is unit-tested directly; the completion provider
// transports the model output here before wrapping it in an InlineCompletionItem.
//
// Even with the validated plain-FIM prompt + raw:true, a small model can still
// echo a special token, fence its answer as markdown, or run past the cursor and
// repeat code that already follows it. These transforms defend against all three.

/** FIM / chat control tokens that must never appear in inserted text. */
const SPECIAL_TOKENS = [
  "<|fim_prefix|>",
  "<|fim_suffix|>",
  "<|fim_middle|>",
  "<|file_sep|>",
  "<|repo_name|>",
  "<|endoftext|>",
  "<|im_start|>",
  "<|im_end|>",
];

/** Remove a leading ```lang line and/or a trailing ``` line, if present. */
function stripCodeFences(text: string): string {
  const lines = text.split("\n");
  if (lines.length > 0 && /^```[a-zA-Z0-9+-]*$/.test(lines[0].trim())) {
    lines.shift();
  }
  if (lines.length > 0 && lines[lines.length - 1].trim() === "```") {
    lines.pop();
  }
  return lines.join("\n");
}

/**
 * Drop any tail of `text` that merely repeats the start of `suffix` (the code
 * already after the cursor), so accepting the suggestion doesn't duplicate a
 * closing bracket, semicolon, or line the user already has.
 */
function trimSuffixOverlap(text: string, suffix: string): string {
  const maxOverlap = Math.min(text.length, suffix.length);
  for (let k = maxOverlap; k > 0; k--) {
    if (text.endsWith(suffix.slice(0, k))) {
      return text.slice(0, text.length - k);
    }
  }
  return text;
}

/**
 * Turn a raw `/api/generate` response into insertable ghost text. `suffix` is
 * the text immediately after the cursor, used to de-duplicate overlap. Returns
 * "" when nothing useful remains — the provider then shows no suggestion.
 */
export function cleanCompletion(raw: string, suffix: string): string {
  let text = raw;
  for (const token of SPECIAL_TOKENS) {
    text = text.split(token).join("");
  }
  text = stripCodeFences(text);
  text = trimSuffixOverlap(text, suffix);
  // Trailing whitespace is noise in ghost text; leading indentation is kept.
  text = text.replace(/\s+$/, "");
  return text.trim().length === 0 ? "" : text;
}
