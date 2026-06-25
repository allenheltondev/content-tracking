import {
  createContent,
  deleteContent,
  getContent,
  listContentByTenant,
  updateContent,
} from "../domain/content.mjs";
import { requireTenantId } from "../services/identity.mjs";
import { withIdempotency } from "../services/idempotency.mjs";
import { decodeCursor, encodeCursor, parseLimit } from "../services/pagination.mjs";
import { emptyResponse, jsonResponse } from "../services/http-handler.mjs";
import { BadRequestError } from "../services/errors.mjs";
import {
  formatContent,
  formatContentSummary,
  validateContentCreate,
  validateContentUpdate,
} from "../validation/content.mjs";

// Content catalog CRUD. Every route resolves the tenant from the authorizer
// sub (requireTenantId) and passes it as the first argument to the domain,
// so reads/writes are confined to the caller's TENANT#{sub} partition.

export function registerContentRoutes(app) {
  app.post("/content", withIdempotency(async ({ event }) => {
    const tenantId = requireTenantId(event);
    const fields = validateContentCreate(parseBody(event));
    const item = await createContent(tenantId, fields);
    return jsonResponse(201, formatContent(item));
  }));

  app.get("/content", async ({ event }) => {
    const tenantId = requireTenantId(event);
    const qs = event.queryStringParameters ?? {};

    const limit = parseLimit(qs.limit);
    const exclusiveStartKey = decodeCursor(qs.startKey);
    const { items, lastEvaluatedKey } = await listContentByTenant(tenantId, {
      limit,
      exclusiveStartKey,
      type: qs.type,
      source: qs.source,
      status: qs.status,
    });
    return jsonResponse(200, {
      content: items.map(formatContentSummary),
      nextStartKey: encodeCursor(lastEvaluatedKey),
    });
  });

  app.get("/content/:contentId", async ({ event, params }) => {
    const tenantId = requireTenantId(event);
    const content = await getContent(tenantId, params.contentId);
    return jsonResponse(200, formatContent(content));
  });

  app.patch("/content/:contentId", async ({ event, params }) => {
    const tenantId = requireTenantId(event);
    const fields = validateContentUpdate(parseBody(event));
    if (Object.keys(fields).length === 0) {
      throw new BadRequestError("request body must contain at least one updatable field");
    }
    const updated = await updateContent(tenantId, params.contentId, fields);
    return jsonResponse(200, formatContent(updated));
  });

  app.delete("/content/:contentId", async ({ event, params }) => {
    const tenantId = requireTenantId(event);
    await deleteContent(tenantId, params.contentId);
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
