// Maps a character offset in a string to a 0-based { line, col }. `col` is the
// offset from the start of that line.
export function offsetToLineCol(text, offset) {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < clamped; i++) {
    if (text[i] === '\n') {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, col: clamped - lineStart };
}

// Reconstructs the file line(s) a suggestion spans with its `[startOffset,
// endOffset)` (offsets into the body) replaced by `replaceWith`. Returns the
// 1-based file line range plus the replacement text — the payload a GitHub
// suggested-change needs, since a ```suggestion block replaces WHOLE lines while
// our replacement is a substring. Lines fully inside a multi-line span are
// consumed (they were part of the replaced text), so the result is
// firstLinePrefix + replaceWith + lastLineSuffix.
export function buildSuggestion({ fileText, bodyOffset, startOffset, endOffset, replaceWith }) {
  const absStart = bodyOffset + startOffset;
  const absEnd = bodyOffset + endOffset;
  const fileLines = fileText.split('\n');

  const start = offsetToLineCol(fileText, absStart);
  const end = offsetToLineCol(fileText, absEnd);

  const firstLine = fileLines[start.line] ?? '';
  const lastLine = fileLines[end.line] ?? '';
  const replacement = firstLine.slice(0, start.col) + (replaceWith ?? '') + lastLine.slice(end.col);

  return {
    startLine: start.line + 1, // 1-based, GitHub line numbers
    endLine: end.line + 1,
    replacement,
  };
}

// The body of a GitHub review comment carrying a one-click suggested change.
export function suggestionCommentBody(replacement, reason, type) {
  const note = reason ? `**${type}** — ${reason}` : `**${type}**`;
  return `${note}\n\n\`\`\`suggestion\n${replacement}\n\`\`\``;
}

// True when every line the suggestion spans is present in the PR diff (the set
// of RIGHT-side line numbers GitHub will accept a comment on). Suggestions that
// aren't fully on diffed lines can't be inline and go in the summary instead.
export function isInlineable(startLine, endLine, commentableLines) {
  for (let l = startLine; l <= endLine; l++) {
    if (!commentableLines.has(l)) return false;
  }
  return true;
}
