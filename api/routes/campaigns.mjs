import { BadRequestError } from "../services/errors.mjs";
import { jsonResponse } from "../services/http-handler.mjs";
import { withIdempotency } from "../services/idempotency.mjs";
import { decodeCursor, encodeCursor, parseLimit } from "../services/pagination.mjs";
import { validateCampaignCreate } from "../validation/campaign.mjs";
import { formatPayout } from "../validation/payout.mjs";
import {
  createCampaign,
  getCampaignWithLinks,
  listCampaigns,
} from "../domain/campaign.mjs";

const VALID_STATUSES = new Set(["draft", "active", "completed"]);

const formatCampaign = (row) => ({
  campaign_id: row.campaignId,
  name: row.name,
  sponsor: row.sponsor ?? null,
  vendor_id: row.vendorId ?? null,
  startDate: row.startDate ?? null,
  endDate: row.endDate ?? null,
  status: row.status,
  targetMetrics: row.targetMetrics ?? null,
  payout: formatPayout(row.payout),
  created_at: row.createdAt,
});

const formatLink = (row) => ({
  link_id: row.linkId,
  code: row.code,
  short_url: row.shortUrl,
  role: row.role,
  platform: row.platform,
  url: row.url,
  src: row.src ?? null,
  notes: row.notes ?? null,
  expires_at: row.expiresAt,
  created_at: row.createdAt,
});

export function registerCampaignRoutes(app) {
  app.post("/campaigns", withIdempotency(async ({ event }) => {
    const body = parseBody(event);
    const fields = validateCampaignCreate(body);
    const item = await createCampaign(fields);
    return jsonResponse(201, formatCampaign(item));
  }));

  app.get("/campaigns", async ({ event }) => {
    const qs = event.queryStringParameters ?? {};
    const limit = parseLimit(qs.limit);
    const exclusiveStartKey = decodeCursor(qs.startKey);

    let status;
    if (qs.status !== undefined) {
      if (!VALID_STATUSES.has(qs.status)) {
        throw new BadRequestError(`status must be one of ${[...VALID_STATUSES].join(", ")}`);
      }
      status = qs.status;
    }

    // vendorId scope is served better by the dedicated
    // /vendors/{id}/campaigns endpoint (one Query, no FilterExpression).
    // We could accept it here too via a redirect, but for now keep the
    // surface simple and document that callers should use the vendor
    // endpoint.

    const { items, lastEvaluatedKey } = await listCampaigns({
      limit,
      exclusiveStartKey,
      status,
    });

    return jsonResponse(200, {
      campaigns: items.map(formatCampaign),
      nextStartKey: encodeCursor(lastEvaluatedKey),
    });
  });

  app.get("/campaigns/:campaignId", async ({ params }) => {
    const { campaignId } = params;
    const { metadata, links } = await getCampaignWithLinks(campaignId);
    return jsonResponse(200, {
      campaign: formatCampaign(metadata),
      links: links.map(formatLink).sort((a, b) => a.created_at.localeCompare(b.created_at)),
    });
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
