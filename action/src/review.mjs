import { buildSuggestion, isInlineable, suggestionCommentBody } from './offsets.mjs';

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Upserts a post by slug, runs a review, and polls it to completion. Returns
// the contentId, the terminal review, and its suggestions. Polling is
// attempts-bounded (and `sleep` is injectable) so a stuck review can't hang the
// job and tests run instantly.
export async function reviewPost(client, post, opts = {}) {
  const { attempts = 60, pollMs = 3000, sleep = defaultSleep } = opts;

  const existing = await client.findBySlug(post.slug);
  const content = existing
    ? await client.updateContent(existing.content_id, { content_markdown: post.body, title: post.title })
    : await client.createContent({
        slug: post.slug,
        title: post.title,
        type: 'blog',
        source: 'owned',
        status: 'draft',
        content_markdown: post.body,
      });

  const contentId = content.content_id;
  const started = await client.startReview(contentId);

  let review = started;
  for (let i = 0; i < attempts && (review.status === 'pending' || review.status === 'running'); i++) {
    await sleep(pollMs);
    review = await client.getReview(contentId, started.id);
  }

  const result = await client.getSuggestions(contentId);
  return { contentId, review: result?.review ?? review, suggestions: result?.suggestions ?? [] };
}

// Turns the review's suggestions into GitHub review comments. Each becomes a
// one-click suggested change when its span sits entirely on diffed lines
// (`commentable`); the rest are returned as `summary` items for a single
// comment, since GitHub can't attach inline comments off the diff.
export function buildComments({ fileText, bodyOffset, suggestions, commentable, path }) {
  const inline = [];
  const summary = [];

  for (const s of suggestions) {
    const { startLine, endLine, replacement } = buildSuggestion({
      fileText,
      bodyOffset,
      startOffset: s.start_offset,
      endOffset: s.end_offset,
      replaceWith: s.replace_with,
    });

    if (isInlineable(startLine, endLine, commentable)) {
      inline.push({
        path,
        // Single-line comments omit start_line; multi-line set both.
        ...(startLine === endLine ? {} : { start_line: startLine, start_side: 'RIGHT' }),
        line: endLine,
        side: 'RIGHT',
        body: suggestionCommentBody(replacement, s.reason, s.type),
      });
    } else {
      summary.push({ ...s, startLine, endLine });
    }
  }

  return { inline, summary };
}

// Hidden marker so re-runs find and update the prior summary comment instead of
// stacking new ones.
export const SUMMARY_MARKER = '<!-- booked-content-review -->';

// Renders the summary comment: the review verdict + summary, then any
// suggestions that couldn't be posted inline (edits to unchanged lines),
// grouped by file, so nothing is silently dropped.
export function renderSummary(perFile) {
  const lines = [SUMMARY_MARKER, '## Content review'];

  for (const { path, review, summary } of perFile) {
    const verdict = review?.lenses?.verdict ? ` — **${String(review.lenses.verdict).replace(/_/g, ' ')}**` : '';
    lines.push('', `### \`${path}\`${verdict}`);
    if (review?.summary) lines.push('', review.summary);
    if (summary.length > 0) {
      lines.push('', 'Suggestions not on changed lines (apply in the app or edit by hand):');
      for (const s of summary) {
        const where = s.startLine === s.endLine ? `L${s.startLine}` : `L${s.startLine}–${s.endLine}`;
        lines.push(`- **${s.type}** (${where}): ${s.reason} — \`${s.text_to_replace}\` → \`${s.replace_with || '(delete)'}\``);
      }
    }
  }

  lines.push('', '_Full review + accept/reject in Booked._');
  return lines.join('\n');
}
