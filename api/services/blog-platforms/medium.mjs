import { logger } from "../logger.mjs";
import { UpstreamError } from "../errors.mjs";

// Medium publish adapter.
//
//   POST https://api.medium.com/v1/publications/{publicationId}/posts
//   auth: accessToken=<token> in the query string (Medium's contract)
//   body: { title, contentFormat: "markdown", tags[], canonicalUrl,
//           publishStatus: "draft", notifyFollowers: true, content }
//
// publicationId comes from the tenant's per-platform config (the legacy
// hardcoded it).

const API_BASE = "https://api.medium.com/v1";

export async function publish({ blog, content, tags = [], config = {}, credential }) {
  if (!credential) {
    throw new Error("Medium credential is not configured for this tenant");
  }
  if (!config.publicationId) {
    throw new Error("Medium publicationId is not configured for this tenant");
  }

  const url = `${API_BASE}/publications/${config.publicationId}/posts?accessToken=${encodeURIComponent(credential)}`;
  const body = {
    title: blog.title,
    contentFormat: "markdown",
    tags,
    canonicalUrl: blog.canonicalUrl,
    publishStatus: "draft",
    notifyFollowers: true,
    content,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "accept": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  if (!response.ok) {
    logger.error("Medium publish failed", { status: response.status, body: text });
    throw new UpstreamError(`Medium publish failed: ${text}`, response.status);
  }

  const data = JSON.parse(text);
  return { id: data.data?.id, url: data.data?.url };
}

// All-time views for a post via Medium's private stats GraphQL. `credential`
// here is the logged-in session cookie (the "medium-cookie" secret), NOT
// the integration token used to publish — Medium has no public stats API.
// A 429 is surfaced as a retryable UpstreamError so the weekly job backs off.
export async function getViews({ id, credential }) {
  if (!id) return 0;
  if (!credential) {
    throw new Error("Medium session cookie is not configured for this tenant");
  }

  const response = await fetch("https://medium.com/_/graphql", {
    method: "POST",
    headers: { "content-type": "application/json", "cookie": credential },
    body: JSON.stringify([{
      operationName: "StatsPostReferrersContainer",
      variables: { postId: id },
      query: "query StatsPostReferrersContainer($postId: ID!) { post(id: $postId) { totalStats { views } } }",
    }]),
  });

  const text = await response.text();
  if (response.status === 429) {
    throw new UpstreamError("Medium stats rate limited", 429);
  }
  if (!response.ok) {
    logger.error("Medium analytics failed", { status: response.status, body: text });
    throw new UpstreamError(`Medium analytics failed: ${text}`, response.status);
  }

  const json = JSON.parse(text);
  return json?.[0]?.data?.post?.totalStats?.views ?? 0;
}
