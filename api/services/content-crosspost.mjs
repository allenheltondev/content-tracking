import { getTenant } from "../domain/tenant.mjs";
import { listContentByTenant, listPublishVariants, putPublishVariant } from "../domain/content.mjs";
import { getBlogCredentials } from "./blog-credentials.mjs";
import { absolutizeCanonical } from "./canonical-url.mjs";
import { transformBlogForPlatform } from "./parse-blog.mjs";
import { getAdapter } from "./blog-platforms/index.mjs";

// Cross-posts a piece of content to dev.to / Medium / Hashnode. Publishes
// synchronously off the Content row; each successful publish is recorded
// as a publish variant so it flows into content analytics. Platforms
// already published (a variant with a url exists) are skipped so a
// re-invoke can't create duplicate posts. Per-platform failures are
// reported in the results array rather than failing the whole call —
// partial success is the intended contract.
export async function crosspostContent({ tenantId, content, platforms }) {
  const contentId = content.contentId;
  const [tenant, credentials, catalogPage, existingVariants] = await Promise.all([
    getTenant(tenantId),
    getBlogCredentials(tenantId),
    listContentByTenant(tenantId, { limit: 1000 }),
    listPublishVariants(tenantId, contentId),
  ]);
  const baseUrl = tenant?.canonicalBaseUrl;
  // The adapters put canonicalUrl straight into the platform's payload (dev.to
  // canonical_url, Medium canonicalUrl, Hashnode originalArticleURL), so a
  // stored path has to become a real URL before it leaves the building — a
  // relative one would be recorded by the platform as its own domain. Null when
  // there's no base configured, which the adapters treat as "no canonical".
  const canonical = absolutizeCanonical(content.canonicalUrl, baseUrl);
  const publishable = { ...content, canonicalUrl: canonical ?? undefined };
  const catalog = catalogPage.items ?? [];
  const alreadyPublished = new Map(
    existingVariants.filter((v) => v.url).map((v) => [v.platform, v.url]),
  );

  const results = [];
  for (const platform of platforms) {
    if (alreadyPublished.has(platform)) {
      results.push({ platform, status: "skipped", url: alreadyPublished.get(platform) });
      continue;
    }
    try {
      const transformed = transformBlogForPlatform({ blog: publishable, catalog, platform, baseUrl });
      const config = tenant?.platforms?.[platform] ?? {};
      const published = await getAdapter(platform).publish({
        blog: publishable,
        content: transformed.body,
        tags: transformed.tags,
        config,
        credential: credentials?.[platform],
      });
      await putPublishVariant(tenantId, contentId, platform, {
        url: published.url,
        publishedAt: new Date().toISOString(),
      });
      results.push({ platform, status: "succeeded", url: published.url });
    } catch (err) {
      results.push({ platform, status: "failed", error: String(err?.message ?? err) });
    }
  }

  return results;
}
