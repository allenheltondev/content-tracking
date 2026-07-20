import { Buffer } from 'node:buffer';
import * as core from '@actions/core';
import * as github from '@actions/github';
import { postFields } from './frontmatter.mjs';
import { commentableLines } from './diff.mjs';
import { createClient } from './booked-client.mjs';
import { reviewPost, buildComments, renderSummary, SUMMARY_MARKER } from './review.mjs';

const MD_RE = /\.m(d|arkdown)$/i;

async function run() {
  const apiUrl = core.getInput('api-url', { required: true });
  const apiKey = core.getInput('api-key', { required: true });
  const postsDir = (core.getInput('posts-dir') || 'content/').replace(/^\.?\/*/, '');
  const platform = core.getInput('platform') || undefined;
  const token = core.getInput('github-token') || process.env.GITHUB_TOKEN;

  const pr = github.context.payload.pull_request;
  if (!pr) {
    core.info('Not a pull_request event; nothing to review.');
    return;
  }

  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;
  const client = createClient({ apiUrl, apiKey });

  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner, repo, pull_number: pr.number, per_page: 100,
  });

  const posts = files.filter(
    (f) => f.status !== 'removed' && MD_RE.test(f.filename) && f.filename.startsWith(postsDir),
  );
  if (posts.length === 0) {
    core.info('No changed blog posts under ' + postsDir);
    return;
  }

  const inlineComments = [];
  const perFile = [];

  for (const file of posts) {
    try {
      const res = await octokit.rest.repos.getContent({ owner, repo, path: file.filename, ref: pr.head.sha });
      const fileText = Buffer.from(res.data.content, res.data.encoding).toString('utf8');

      const post = postFields(fileText, file.filename);
      if (post.draft) {
        core.info(`Skipping draft: ${file.filename}`);
        continue;
      }

      core.info(`Reviewing ${file.filename} (slug: ${post.slug})`);
      const { review, suggestions } = await reviewPost(client, post, { platform });

      const commentable = commentableLines(file.patch);
      const { inline, summary, inlineSummary } = buildComments({
        fileText, bodyOffset: post.bodyOffset, suggestions, commentable, path: file.filename,
      });

      inlineComments.push(...inline);
      perFile.push({ path: file.filename, review, summary, inlineSummary });
      core.info(`  ${suggestions.length} suggestion(s): ${inline.length} inline, ${summary.length} in summary`);
    } catch (err) {
      core.warning(`Failed to review ${file.filename}: ${err.message}`);
    }
  }

  if (perFile.length === 0) return;

  // One review carrying every inline suggested change. GitHub rejects a review
  // whose comments fall outside the diff; we only add inlineable ones, but if
  // the whole review is rejected, fold those suggestions into the summary
  // comment so none are dropped.
  let inlinePosted = false;
  if (inlineComments.length > 0) {
    try {
      await octokit.rest.pulls.createReview({
        owner, repo, pull_number: pr.number, event: 'COMMENT', comments: inlineComments,
      });
      inlinePosted = true;
    } catch (err) {
      core.warning(`Could not post inline suggestions (${err.message}); folding them into the summary comment.`);
    }
  }

  // On success the summary lists only the off-diff suggestions (the inline ones
  // are already on the PR); on failure it also carries the ones that would have
  // been inline.
  const summaryPerFile = perFile.map((f) => ({
    path: f.path,
    review: f.review,
    summary: inlinePosted ? f.summary : [...f.summary, ...f.inlineSummary],
  }));
  await upsertSummary(octokit, owner, repo, pr.number, renderSummary(summaryPerFile));
}

// Creates the summary comment, or updates the prior one (found by its marker) so
// re-runs don't stack.
async function upsertSummary(octokit, owner, repo, issue_number, body) {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner, repo, issue_number, per_page: 100,
  });
  const existing = comments.find((c) => typeof c.body === 'string' && c.body.includes(SUMMARY_MARKER));
  if (existing) {
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
  } else {
    await octokit.rest.issues.createComment({ owner, repo, issue_number, body });
  }
}

run().catch((err) => core.setFailed(err.message));
