import { BadRequestError } from "../services/errors.mjs";
import { emptyResponse, jsonResponse, parseBody } from "../services/http-handler.mjs";
import { withIdempotency } from "../services/idempotency.mjs";
import { createLink, deleteLink, updateLink } from "../domain/link.mjs";
import { assertCampaignOwned } from "../domain/campaign.mjs";
import { requireTenantId } from "../services/identity.mjs";

const VALID_ROLES = new Set(["main", "cross_post", "social_promo"]);

const EDITABLE_FIELDS = {
  notes: "notes",
  src: "src",
  expires_at: "expiresAt",
};
const IMMUTABLE_FIELDS = new Set([
  "campaign_id", "link_id", "code", "short_url", "url", "role",
  "platform", "created_at", "createdAt", "campaignId", "linkId", "shortUrl",
]);

const formatLink = (row) => ({
  campaign_id: row.campaignId,
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

export function registerLinkRoutes(app) {
  app.post("/campaigns/:campaignId/links", withIdempotency(async ({ event, params }) => {
    const { campaignId } = params;
    const tenantId = requireTenantId(event);
    await assertCampaignOwned(campaignId, tenantId);
    const body = parseBody(event);
    const fields = validateCreate(body);
    const item = await createLink(campaignId, fields);
    return jsonResponse(201, formatLink(item));
  }));

  app.put("/campaigns/:campaignId/links/:linkId", async ({ event, params }) => {
    const { campaignId, linkId } = params;
    const tenantId = requireTenantId(event);
    await assertCampaignOwned(campaignId, tenantId);
    const body = parseBody(event);

    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new BadRequestError("Body must be a JSON object");
    }
    if (Object.keys(body).length === 0) {
      throw new BadRequestError("request body must contain at least one updatable field");
    }

    // Whitelist enforcement matches PR #34: explicit error on immutable
    // fields, including their camelCase aliases.
    for (const key of Object.keys(body)) {
      if (IMMUTABLE_FIELDS.has(key)) {
        throw new BadRequestError(`Field "${key}" is immutable and cannot be updated`);
      }
      if (!Object.prototype.hasOwnProperty.call(EDITABLE_FIELDS, key)) {
        throw new BadRequestError(`Field "${key}" is not editable`);
      }
    }

    const fields = validateUpdate(body);
    const updated = await updateLink(campaignId, linkId, fields);
    return jsonResponse(200, formatLink(updated));
  });

  app.delete("/campaigns/:campaignId/links/:linkId", async ({ event, params }) => {
    const { campaignId, linkId } = params;
    const tenantId = requireTenantId(event);
    await assertCampaignOwned(campaignId, tenantId);
    await deleteLink(campaignId, linkId);
    return emptyResponse(204);
  });
}

function validateCreate(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequestError("Body must be a JSON object");
  }
  const { role, platform, url, src, notes, expiresInDays } = body;
  if (!role || !VALID_ROLES.has(role)) {
    throw new BadRequestError(`role must be one of ${[...VALID_ROLES].join(", ")}`);
  }
  if (!platform || typeof platform !== "string" || platform.length === 0 || platform.length > 64) {
    throw new BadRequestError("platform is required (1-64 chars)");
  }
  if (!url || typeof url !== "string") {
    throw new BadRequestError("url is required");
  }
  if (!/^https?:\/\//i.test(url)) {
    throw new BadRequestError("url must be http or https");
  }
  if (url.length > 2048) {
    throw new BadRequestError("url exceeds 2048 chars");
  }
  if (src !== undefined && (typeof src !== "string" || src.length > 64)) {
    throw new BadRequestError("src must be a string up to 64 chars");
  }
  if (notes !== undefined && (typeof notes !== "string" || notes.length > 1000)) {
    throw new BadRequestError("notes must be a string up to 1000 chars");
  }
  if (expiresInDays !== undefined) {
    if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 1825) {
      throw new BadRequestError("expiresInDays must be an integer between 1 and 1825");
    }
  }
  return { role, platform, url, src, notes, expiresInDays };
}

function validateUpdate(body) {
  const out = {};
  for (const [key, value] of Object.entries(body)) {
    const ddbKey = EDITABLE_FIELDS[key];
    if (value === null) {
      out[ddbKey] = null;
      continue;
    }
    if (key === "notes") {
      if (typeof value !== "string" || value.length > 1000) {
        throw new BadRequestError("notes must be a string up to 1000 chars");
      }
    } else if (key === "src") {
      if (typeof value !== "string" || value.length > 64) {
        throw new BadRequestError("src must be a string up to 64 chars");
      }
    } else if (key === "expires_at") {
      if (typeof value !== "string" || isNaN(Date.parse(value))) {
        throw new BadRequestError("expires_at must be an ISO date-time string");
      }
    }
    out[ddbKey] = value;
  }
  return out;
}