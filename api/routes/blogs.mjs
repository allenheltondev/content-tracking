import { ulid } from "ulid";
import {
  createBlog,
  deleteBlog,
  findBlog,
  getBlog,
  getCrosspostStatus,
  listBlogsByTenant,
  listBlogsForCampaign,
  updateBlog,
} from "../domain/blog.mjs";
import { requireTenantId } from "../services/identity.mjs";
import { withIdempotency } from "../services/idempotency.mjs";
import { decodeCursor, encodeCursor, parseLimit } from "../services/pagination.mjs";
import { startCrosspostExecution } from "../services/crosspost-invoker.mjs";
import { emptyResponse, jsonResponse } from "../services/http-handler.mjs";
import { BadRequestError, NotFoundError } from "../services/errors.mjs";
import {
  formatBlog,
  formatBlogSummary,
  formatCrosspostStatus,
  validateBlogCreate,
  validateBlogUpdate,
  validateCrosspostRequest,
} from "../validation/blog.mjs";

const SECONDS_PER_DAY = 24 * 60 * 60;

// Blog catalog CRUD. Every route resolves the tenant from the authorizer
// sub (requireTenantId) and passes it as the first argument to the domain,
// so reads/writes are confined to the caller's TENANT#{sub} partition.

export function registerBlogRoutes(app) {
  app.post("/blogs", withIdempotency(async ({ event }) => {
    const tenantId = requireTenantId(event);
    const fields = validateBlogCreate(parseBody(event));
    const item = await createBlog(tenantId, fields);
    return jsonResponse(201, formatBlog(item));
  }));

  app.get("/blogs", async ({ event }) => {
    const tenantId = requireTenantId(event);
    const qs = event.queryStringParameters ?? {};

    // ?campaignId=… returns just the blogs linked to that campaign (used by
    // the campaign detail view). It's a bounded set, so it isn't paginated.
    if (qs.campaignId) {
      const items = await listBlogsForCampaign(tenantId, qs.campaignId);
      return jsonResponse(200, {
        blogs: items.map(formatBlogSummary),
        nextStartKey: null,
      });
    }

    const limit = parseLimit(qs.limit);
    const exclusiveStartKey = decodeCursor(qs.startKey);
    const { items, lastEvaluatedKey } = await listBlogsByTenant(tenantId, { limit, exclusiveStartKey });
    return jsonResponse(200, {
      blogs: items.map(formatBlogSummary),
      nextStartKey: encodeCursor(lastEvaluatedKey),
    });
  });

  app.get("/blogs/:blogId", async ({ event, params }) => {
    const tenantId = requireTenantId(event);
    const blog = await getBlog(tenantId, params.blogId);
    return jsonResponse(200, formatBlog(blog));
  });

  app.patch("/blogs/:blogId", async ({ event, params }) => {
    const tenantId = requireTenantId(event);
    const fields = validateBlogUpdate(parseBody(event));
    if (Object.keys(fields).length === 0) {
      throw new BadRequestError("request body must contain at least one updatable field");
    }
    const updated = await updateBlog(tenantId, params.blogId, fields);
    return jsonResponse(200, formatBlog(updated));
  });

  app.delete("/blogs/:blogId", async ({ event, params }) => {
    const tenantId = requireTenantId(event);
    await deleteBlog(tenantId, params.blogId);
    return emptyResponse(204);
  });

  // On-demand cross-post: validate, generate a runId, and start the durable
  // execution (async). Returns immediately; the client polls the status
  // route below. Wrapped in withIdempotency so a client retry with the same
  // Idempotency-Key returns the original runId instead of starting a second
  // run (the durable execution name + per-platform guard dedupe the rest).
  app.post("/blogs/:blogId/crosspost", withIdempotency(async ({ event, params }) => {
    const tenantId = requireTenantId(event);
    const blog = await findBlog(tenantId, params.blogId);
    if (!blog) {
      throw new NotFoundError("Blog", params.blogId);
    }

    const { platforms, staggerDays } = validateCrosspostRequest(parseBody(event));
    const runId = ulid();
    const withDelays = platforms.map((platform, i) => ({
      platform,
      delaySeconds: staggerDays ? i * staggerDays * SECONDS_PER_DAY : 0,
    }));

    await startCrosspostExecution({ tenantId, blogId: params.blogId, runId, platforms: withDelays });

    return jsonResponse(202, {
      run_id: runId,
      status: "in progress",
      platforms: withDelays.map((p) => ({ platform: p.platform, delay_seconds: p.delaySeconds })),
    });
  }));

  app.get("/blogs/:blogId/crosspost-status", async ({ event, params }) => {
    const tenantId = requireTenantId(event);
    // Pass ?run_id=… to correlate the poll to a specific (just-started) run
    // rather than whatever the latest persisted run happens to be.
    const runId = event.queryStringParameters?.run_id;
    const status = await getCrosspostStatus(tenantId, params.blogId, { runId });
    return jsonResponse(200, formatCrosspostStatus(status));
  });
}

function parseBody(event) {
  if (!event.body) {
    throw new BadRequestError("Missing request body");
  }
  try {
    return JSON.parse(event.body);
  } catch {
    throw new BadRequestError("Invalid JSON body");
  }
}
