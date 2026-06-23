import { logger } from "../logger.mjs";
import { UpstreamError } from "../errors.mjs";

// Hashnode publish adapter (GraphQL).
//
//   POST https://gql.hashnode.com
//   auth: Authorization: <token>
//   body: publishPost mutation with variables.input
//
// publicationId / blogUrl come from the tenant's per-platform config.
// parse-blog produces tag strings; Hashnode wants { slug, name } objects,
// so we map here.

const GQL_URL = "https://gql.hashnode.com";
const PUBLISH_MUTATION =
  "mutation PublishPost($input: PublishPostInput!) { publishPost(input: $input) { post { id slug url } } }";

export async function publish({ blog, content, tags = [], config = {}, credential }) {
  if (!credential) {
    throw new Error("Hashnode credential is not configured for this tenant");
  }
  if (!config.publicationId) {
    throw new Error("Hashnode publicationId is not configured for this tenant");
  }

  const input = {
    title: blog.title,
    subtitle: blog.description,
    publicationId: config.publicationId,
    contentMarkdown: content,
    originalArticleURL: blog.canonicalUrl,
    tags: tags.map((tag) => ({ slug: tag, name: tag })),
    metaTags: {
      title: blog.title,
      description: blog.description,
      image: blog.image,
    },
  };
  if (blog.image) {
    input.coverImageOptions = {
      coverImageURL: blog.image,
      ...(blog.imageAttribution ? { coverImageAttribution: blog.imageAttribution } : {}),
    };
  }

  const response = await fetch(GQL_URL, {
    method: "POST",
    headers: { "Authorization": credential, "content-type": "application/json" },
    body: JSON.stringify({ query: PUBLISH_MUTATION, variables: { input } }),
  });

  const text = await response.text();
  if (!response.ok) {
    logger.error("Hashnode publish failed", { status: response.status, body: text });
    throw new UpstreamError(`Hashnode publish failed: ${text}`, response.status);
  }

  // GraphQL returns 200 even on errors, so inspect the body.
  const data = JSON.parse(text);
  if (data.errors?.length) {
    logger.error("Hashnode publish returned GraphQL errors", { errors: data.errors });
    throw new UpstreamError(`Hashnode publish failed: ${JSON.stringify(data.errors)}`, 502);
  }

  const post = data.data?.publishPost?.post;
  if (!post?.slug) {
    throw new UpstreamError("Hashnode publish returned no post", 502);
  }

  // Prefer the URL Hashnode returns; fall back to composing it from the
  // tenant's blog URL + slug (what the legacy did).
  const url = post.url
    ?? (config.blogUrl ? `${config.blogUrl.replace(/\/+$/, "")}/${post.slug}` : undefined);

  return { id: post.id, slug: post.slug, url };
}
