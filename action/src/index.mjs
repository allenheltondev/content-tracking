import { Buffer } from 'node:buffer';
import * as core from '@actions/core';
import * as github from '@actions/github';
import { postFields } from './frontmatter.mjs';
import { commentableLines } from './diff.mjs';
import { createClient } from './booked-client.mjs';
import { reviewPost, buildComments, renderSummary, SUMMARY_MARKER } from './review.mjs';
import { publishPost } from './publish.mjs';

const MD_RE = /\.m(d|arkdown)$/i;
// The `before` a push payload carries when there is nothing to compare against
// (a branch's first push).
const NO_COMMIT = '0000000000000000000000000000000000000000';

// Two modes, meant for two workflows in the same blog repo:
//   review  (pull_request) — register the changed post, review it, comment back
//   publish (merge)        — final sync of body + metadata, status `published`,
//                            which is what starts voice learning
async function run() {
  const mode = (core.getInput('mode') || 'review').trim().toLowerCase();
  const apiUrl = core.getInput('api-url', { required: true });
  const apiKey = core.getInput('api-key', { required: true });
  const postsDir = (core.getInput('posts-dir') || 'content/').replace(/^\.?\/*/, '');
  const platform = core.getInput('platform') || undefined;
  const siteUrl = core.getInput('site-url') || undefined;
  const token = core.getInput('github-token') || process.env.GITHUB_TOKEN;

  const { owner, repo } = github.context.repo;
  const ctx = {
    octokit: github.getOctokit(token),
    client: createClient({ apiUrl, apiKey }),
    owner,
    repo,
    postsDir,
    platform,
    siteUrl,
  };

  if (mode === 'review') return reviewChangedPosts(ctx);
  if (mode === 'publish') return publishMergedPosts(ctx);
  throw new Error(`unknown mode "${mode}" — expected "review" or "publish"`);
}

// --------------------------------------------------------------------------
// review mode (pull_request)
// --------------------------------------------------------------------------

async function reviewChangedPosts({ octokit, client, owner, repo, postsDir, platform }) {
  const pr = github.context.payload.pull_request;
  if (!pr) {
    core.info('Not a pull_request event; nothing to review.');
    return;
  }

  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner, repo, pull_number: pr.number, per_page: 100,
  });

  const posts = files.filter((f) => isPost(f, postsDir));
  if (posts.length === 0) {
    core.info('No changed blog posts under ' + postsDir);
    return;
  }

  const inlineComments = [];
  const perFile = [];
  // Posts we couldn't review (timed-out or erroring review). Carried into the
  // summary comment so an updated comment never implies a post was reviewed
  // clean when it wasn't.
  const failures = [];

  for (const file of posts) {
    try {
      const fileText = await readFile(octokit, owner, repo, file.filename, pr.head.sha);
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
      failures.push({ path: file.filename, message: err.message });
    }
  }

  if (perFile.length === 0 && failures.length === 0) return;

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
  await upsertSummary(octokit, owner, repo, pr.number, renderSummary(summaryPerFile, failures));
}

// --------------------------------------------------------------------------
// publish mode (merge)
// --------------------------------------------------------------------------

async function publishMergedPosts({ octokit, client, owner, repo, postsDir, siteUrl }) {
  const { files, sha } = await mergedFiles(octokit, owner, repo);
  if (!files) return;

  const posts = files.filter((f) => isPost(f, postsDir));
  if (posts.length === 0) {
    core.info('No merged blog posts under ' + postsDir);
    return;
  }

  // Without `site-url` each post records a site-relative canonical path, which
  // Booked resolves with the canonical base URL from Settings. Two cases are
  // worth a word before publishing anything:
  //   - the API is too old to accept a path, so no canonical is recorded at all
  //     (sending one would 400 every post);
  //   - it accepts paths but no base URL is configured, so the stored path is
  //     right yet nothing can turn it into a URL.
  let paths = true;
  if (!siteUrl) {
    const settings = await client.publishingSettings().catch(() => ({ supported: true, canonicalBaseUrl: null }));
    paths = settings.supported;
    if (!settings.supported) {
      core.warning(
        'This Booked deployment predates site-relative canonical URLs, so posts will be published ' +
        'without one. Upgrade the stack, or set the site-url input to record absolute URLs.',
      );
    } else if (!settings.canonicalBaseUrl) {
      core.warning(
        'No canonical base URL configured in Booked (Settings → Publishing) and no site-url input; ' +
        'canonical links will be stored as paths but cannot be resolved to URLs.',
      );
    }
  }

  const published = [];
  const failures = [];

  for (const file of posts) {
    try {
      const post = postFields(await readFile(octokit, owner, repo, file.filename, sha), file.filename);
      if (post.draft) {
        // Merged but still flagged draft in front matter: the site won't build
        // it, so Booked shouldn't call it published either.
        core.info(`Skipping draft: ${file.filename}`);
        continue;
      }

      const { contentId, created, canonicalUrl } = await publishPost(client, post, { siteUrl, postsDir, paths });
      core.info(
        `Published ${file.filename} → ${contentId} (${created ? 'created' : 'updated'}` +
        `${post.publishDate ? `, ${post.publishDate}` : ', no publish date'}` +
        `${canonicalUrl ? `, ${canonicalUrl}` : ''})`,
      );
      published.push({ path: file.filename, content_id: contentId, created });
    } catch (err) {
      core.error(`Failed to publish ${file.filename}: ${err.message}`);
      failures.push(file.filename);
    }
  }

  core.setOutput('published', JSON.stringify(published));
  core.setOutput('published-count', String(published.length));

  // Publishing is the record-keeping step AND the voice-learning trigger, and
  // nothing downstream retries it — a post that silently fails here is a post
  // the voice never learns from. Fail the job so the merge is visibly red.
  if (failures.length > 0) {
    core.setFailed(`Could not publish ${failures.length} post(s): ${failures.join(', ')}`);
  }
}

// The files a merge brought in, plus the sha to read them at. Covers both ways
// a workflow catches a merge: `on: push` to the default branch, and
// `on: pull_request` with `types: [closed]`. Returns {} when the event isn't a
// merge, so the caller can bow out quietly.
async function mergedFiles(octokit, owner, repo) {
  const payload = github.context.payload;
  const pr = payload.pull_request;

  if (pr) {
    if (!pr.merged) {
      core.info('Pull request closed without merging; nothing to publish.');
      return {};
    }
    const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
      owner, repo, pull_number: pr.number, per_page: 100,
    });
    return { files, sha: pr.merge_commit_sha ?? pr.base?.sha };
  }

  const after = payload.after ?? github.context.sha;
  if (!after) {
    core.info('No push or pull_request payload; nothing to publish.');
    return {};
  }

  // A branch's first push has no `before` to compare against — take the head
  // commit's own files instead.
  const before = payload.before;
  if (!before || before === NO_COMMIT) {
    const commit = await octokit.rest.repos.getCommit({ owner, repo, ref: after });
    return { files: commit.data.files ?? [], sha: after };
  }

  // Not paginated: compare returns at most 300 files, far past what a blog
  // merge touches, and warns rather than silently publishing a subset.
  const cmp = await octokit.rest.repos.compareCommitsWithBasehead({
    owner, repo, basehead: `${before}...${after}`,
  });
  const files = cmp.data.files ?? [];
  if (files.length >= 300) {
    core.warning('The push changed 300+ files; GitHub truncates the comparison, so some posts may be missed.');
  }
  return { files, sha: after };
}

// --------------------------------------------------------------------------
// shared helpers
// --------------------------------------------------------------------------

function isPost(file, postsDir) {
  return file.status !== 'removed' && MD_RE.test(file.filename) && file.filename.startsWith(postsDir);
}

async function readFile(octokit, owner, repo, path, ref) {
  const res = await octokit.rest.repos.getContent({ owner, repo, path, ref });
  if (!res.data.content) {
    // Over the contents API's inline limit — rare for a post, but reading an
    // empty string would register the file as having no body.
    throw new Error(`${path} is too large to read through the contents API`);
  }
  return Buffer.from(res.data.content, res.data.encoding).toString('utf8');
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
