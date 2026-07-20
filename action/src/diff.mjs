// Parses a unified-diff `patch` (as GitHub returns per file) into the set of
// RIGHT-side (new file) line numbers a review comment can attach to — the added
// ('+') and context (' ') lines inside each hunk. Deleted ('-') lines are on the
// left side and don't advance the new-file counter. GitHub only accepts inline
// comments / suggested changes on lines in this set.
export function commentableLines(patch) {
  const lines = new Set();
  if (typeof patch !== 'string' || patch.length === 0) return lines;

  let newLine = 0;
  for (const row of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (row.startsWith('+')) {
      lines.add(newLine);
      newLine += 1;
    } else if (row.startsWith('-')) {
      // left side only — does not advance the new-file line counter
    } else if (row.startsWith('\\')) {
      // "\ No newline at end of file" — metadata, ignore
    } else {
      // context line (leading space, or an empty context line)
      lines.add(newLine);
      newLine += 1;
    }
  }
  return lines;
}
