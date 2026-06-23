import {
  createBlog,
  deleteBlog,
  getBlog,
  listBlogsByTenant,
  updateBlog,
} from "../domain/blog.mjs";
import { requireTenantId } from "../services/identity.mjs";
import { withIdempotency } from "../services/idempotency.mjs";
import { decodeCursor, encodeCursor, parseLimit } from "../services/pagination.mjs";
import { emptyResponse, jsonResponse } from "../services/http-handler.mjs";
import { BadRequestError } from "../services/errors.mjs";
import {
  formatBlog,
  formatBlogSummary,
  validateBlogCreate,
  validateBlogUpdate,
} from "../validation/blog.mjs";

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
