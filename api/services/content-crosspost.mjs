import { getTenant } from "../domain/tenant.mjs";
import { listContentByTenant, listPublishVariants, putPublishVariant } from "../domain/content.mjs";
import { getBlogCredentials } from "./blog-credentials.mjs";
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
      const transformed = transformBlogForPlatform({ blog: content, catalog, platform, baseUrl });
      const config = tenant?.platforms?.[platform] ?? {};
      const published = await getAdapter(platform).publish({
        blog: content,
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
