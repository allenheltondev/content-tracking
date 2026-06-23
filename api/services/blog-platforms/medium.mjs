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
