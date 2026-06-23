import { logger } from "../logger.mjs";
import { UpstreamError } from "../errors.mjs";

// Dev.to publish adapter. Inlined fetch (no shared SendApiRequest lambda).
// Consumes the { content, tags } produced by parse-blog plus the blog
// metadata and the tenant's per-platform config.
//
//   POST https://dev.to/api/articles
//   auth:   api-key: <token>
//   accept: application/vnd.forem.api-v1+json
//   body:   { article: { title, published, main_image, canonical_url,
//                         description, tags[], organization_id?, body_markdown } }

const ARTICLES_URL = "https://dev.to/api/articles";

// Dev.to rejects more than 4 tags, so cap here (a platform limit, hence the
// adapter's responsibility rather than parse-blog's).
const MAX_TAGS = 4;

export async function publish({ blog, content, tags = [], config = {}, credential }) {
  if (!credential) {
    throw new Error("Dev.to credential is not configured for this tenant");
  }

  const article = {
    title: blog.title,
    published: true,
    main_image: blog.image,
    canonical_url: blog.canonicalUrl,
    description: blog.description,
    tags: tags.slice(0, MAX_TAGS),
    body_markdown: content,
  };
  if (config.organizationId) {
    article.organization_id = Number(config.organizationId);
  }

  const response = await fetch(ARTICLES_URL, {
    method: "POST",
    headers: {
      "api-key": credential,
      "accept": "application/vnd.forem.api-v1+json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ article }),
  });

  const text = await response.text();
  if (!response.ok) {
    logger.error("Dev.to publish failed", { status: response.status, body: text });
    throw new UpstreamError(`Dev.to publish failed: ${text}`, response.status);
  }

  const data = JSON.parse(text);
  return { id: data.id, url: data.url };
}
