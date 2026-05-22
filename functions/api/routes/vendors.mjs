import {
  createVendor,
  deleteVendor,
  getVendor,
  listCampaignsForVendor,
  listVendors,
  updateVendor,
} from "../domain/vendor.mjs";
import { withIdempotency } from "../services/idempotency.mjs";
import { decodeCursor, encodeCursor, parseLimit } from "../services/pagination.mjs";
import { emptyResponse, jsonResponse } from "../services/http-handler.mjs";
import { BadRequestError } from "../services/errors.mjs";
import { formatVendor, validateVendorPayload } from "../validation/vendor.mjs";

const formatVendorCampaign = (row) => ({
  campaign_id: row.campaignId,
  name: row.name,
  status: row.status,
  startDate: row.startDate ?? null,
  endDate: row.endDate ?? null,
  created_at: row.createdAt,
});

export function registerVendorRoutes(app) {
  app.post("/vendors", withIdempotency(async ({ event }) => {
    const body = parseBody(event);
    const fields = validateVendorPayload(body, { requireName: true });
    const item = await createVendor(fields);
    return jsonResponse(201, formatVendor(item));
  }));

  app.get("/vendors", async ({ event }) => {
    const qs = event.queryStringParameters ?? {};
    const limit = parseLimit(qs.limit);
    const exclusiveStartKey = decodeCursor(qs.startKey);
    const { items, lastEvaluatedKey } = await listVendors({ limit, exclusiveStartKey });
    return jsonResponse(200, {
      vendors: items.map(formatVendor),
      nextStartKey: encodeCursor(lastEvaluatedKey),
    });
  });

  app.get("/vendors/:vendorId", async ({ event }) => {
    const { vendorId } = event.pathParameters ?? {};
    const vendor = await getVendor(vendorId);
    return jsonResponse(200, formatVendor(vendor));
  });

  app.put("/vendors/:vendorId", async ({ event }) => {
    const { vendorId } = event.pathParameters ?? {};
    const body = parseBody(event);
    const fields = validateVendorPayload(body, { requireName: false });
    if (Object.keys(fields).length === 0) {
      throw new BadRequestError("request body must contain at least one updatable field");
    }
    const updated = await updateVendor(vendorId, fields);
    return jsonResponse(200, formatVendor(updated));
  });

  app.delete("/vendors/:vendorId", async ({ event }) => {
    const { vendorId } = event.pathParameters ?? {};
    await deleteVendor(vendorId);
    return emptyResponse(204);
  });

  app.get("/vendors/:vendorId/campaigns", async ({ event }) => {
    const { vendorId } = event.pathParameters ?? {};
    const items = await listCampaignsForVendor(vendorId);
    const campaigns = items
      .map(formatVendorCampaign)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return jsonResponse(200, { vendor_id: vendorId, campaigns });
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
