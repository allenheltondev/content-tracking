import { withDurableExecution } from "@aws/durable-execution-sdk-js";
import {
  completeCrosspostRun,
  getBlog,
  listBlogsByTenant,
  recordCrosspostResult,
  startCrosspostRun,
} from "../../api/domain/blog.mjs";
import { getTenant } from "../../api/domain/tenant.mjs";
import { getBlogCredentials } from "../../api/services/blog-credentials.mjs";
import { transformBlogForPlatform } from "../../api/services/parse-blog.mjs";
import { getAdapter } from "../../api/services/blog-platforms/index.mjs";

// Cross-post durable function. Publishes one blog to the requested
// platforms on demand, optionally staggered. It is a durable function
// because the work is multi-step, stateful, and long-running (a stagger
// can span days) — the API trigger only validates and starts the
// execution; everything below runs as durable steps so a mid-flight
// failure or a multi-day wait replays cleanly.
//
// Event shape (from the trigger, #137):
//   { tenantId, blogId, runId, platforms: [{ platform, delaySeconds }] }
//
// Flow:
//   step  load-context     — blog + tenant config + catalog (no secrets)
//   step  start-run        — run row "in progress" + seed copy rows
//   map   publish-platforms — per platform, concurrently:
//           wait delaySeconds  (skipped when 0)
//           step transform     — parse-blog → { body, tags }
//           step publish       — adapter fetch (credential read inside, so
//                                it is never checkpointed); never throws —
//                                returns a succeeded/failed outcome
//           step record        — write the copy row (+ mirror onto blog)
//   step  finalize-run     — overall status from the per-platform outcomes
export const handler = withDurableExecution(async (event, context) => {
  const { tenantId, blogId, runId, platforms = [] } = event;

  const loaded = await context.step("load-context", async () => {
    const blog = await getBlog(tenantId, blogId);
    const tenant = await getTenant(tenantId);
    // The whole catalog backs cross-link rewriting. Article volume is small.
    const { items: catalog } = await listBlogsByTenant(tenantId, { limit: 1000 });
    return { blog, tenant, catalog };
  });

  await context.step("start-run", async () => {
    await startCrosspostRun(tenantId, blogId, { runId, platforms });
  });

  const baseUrl = loaded.tenant?.canonicalBaseUrl;

  const batch = await context.map("publish-platforms", platforms, async (branchContext, p) => {
    try {
      if (p.delaySeconds > 0) {
        await branchContext.wait({ seconds: p.delaySeconds });
      }

      const transformed = await branchContext.step(`transform:${p.platform}`, async () =>
        transformBlogForPlatform({ blog: loaded.blog, catalog: loaded.catalog, platform: p.platform, baseUrl }));

      // The publish step never throws: it returns a succeeded/failed
      // outcome so the per-platform result is always checkpointed cleanly
      // and one platform's failure can't abort the others.
      const outcome = await branchContext.step(`publish:${p.platform}`, async () => {
        try {
          const config = loaded.tenant?.platforms?.[p.platform] ?? {};
          const credentials = await getBlogCredentials(tenantId);
          const published = await getAdapter(p.platform).publish({
            blog: loaded.blog,
            content: transformed.body,
            tags: transformed.tags,
            config,
            credential: credentials?.[p.platform],
          });
          return { status: "succeeded", url: published.url, id: published.id, slug: published.slug };
        } catch (err) {
          return { status: "failed", error: errorMessage(err) };
        }
      });

      await branchContext.step(`record:${p.platform}`, async () => {
        await recordCrosspostResult(tenantId, blogId, p.platform, { runId, ...outcome });
      });

      return { platform: p.platform, ...outcome };
    } catch (err) {
      return { platform: p.platform, status: "failed", error: errorMessage(err) };
    }
  });

  const results = batch.getResults();
  const allSucceeded =
    results.length === platforms.length && results.every((r) => r.status === "succeeded");

  await context.step("finalize-run", async () => {
    await completeCrosspostRun(tenantId, blogId, runId, allSucceeded ? "succeeded" : "failed");
  });

  return { runId, status: allSucceeded ? "succeeded" : "failed", results };
});

function errorMessage(err) {
  return String(err?.message ?? err);
}
