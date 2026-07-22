import { BadRequestError, NotFoundError } from "../services/errors.mjs";
import { jsonResponse, parseBody } from "../services/http-handler.mjs";
import { withIdempotency } from "../services/idempotency.mjs";
import { logger } from "../services/logger.mjs";
import { decodeCursor, encodeCursor, parseLimit } from "../services/pagination.mjs";
import { attachBrief, reviewCampaignDraft } from "../services/brief-pipeline.mjs";
import { presignBriefDownload, presignBriefUpload } from "../services/s3.mjs";
import { formatCampaign, validateCampaignCreate, validateCampaignUpdate } from "../validation/campaign.mjs";
import {
  validateBriefSubmission,
  validateUploadUrlRequest,
} from "../validation/brief.mjs";
import { validateDraftSubmission } from "../validation/draft.mjs";
import { applyPaidAtDefault } from "../validation/payout.mjs";
import { requireUlid } from "../validation/common.mjs";
import { formatLink } from "../validation/link.mjs";
import {
  assertCampaignOwned,
  createCampaign,
  getCampaignWithLinks,
  listCampaigns,
  updateCampaignFields,
} from "../domain/campaign.mjs";
import { requireTenantId } from "../services/identity.mjs";
import { trackActivity } from "../services/activity.mjs";
import { assertVendorOwned } from "../domain/vendor.mjs";
import { getDraftForCampaign, saveDraftForCampaign } from "../domain/draft.mjs";
import { formatSocialPost } from "../validation/social-post.mjs";
import { formatContentPost } from "../validation/content-post.mjs";

const VALID_STATUSES = new Set(["draft", "active", "monitoring", "completed"]);

const formatBrief = (row, downloadUrl) => ({
  source_type: row.sourceType,
  summary: row.summary,
  suggested_campaign: row.suggestedCampaign ?? {},
  warnings: row.warnings ?? [],
  raw: downloadUrl ? { download_url: downloadUrl } : null,
  created_at: row.createdAt,
});

const formatDraft = (row) => ({
  url: row.url,
  doc_id: row.docId ?? null,
  review: row.review ?? null,
  reviewed_at: row.reviewedAt ?? null,
  created_at: row.createdAt,
  updated_at: row.updatedAt ?? row.createdAt,
});

export function registerCampaignRoutes(app) {
  app.post("/campaigns", withIdempotency(async ({ event }) => {
    const tenantId = requireTenantId(event);
    const body = parseBody(event);
    const fields = validateCampaignCreate(body);
    // A vendor link writes a row under the vendor's partition and surfaces in
    // its /vendors/:id/campaigns list, so confirm the vendor is the caller's
    // before accepting it — otherwise a guessed id would let a user pollute
    // another tenant's vendor. 404s a missing/foreign vendor.
    if (fields.vendorId) {
      await assertVendorOwned(fields.vendorId, tenantId);
    }
    const item = await createCampaign({ ...fields, tenantId });
    // Gamification: a created campaign is the "Deal Maker" activity (and feeds
    // the higher campaign-count tiers). Idempotent per campaign so a retry with
    // the same Idempotency-Key can't double-count.
    await trackActivity(tenantId, "campaign.created", {
      id: `campaign.created#${tenantId}#${item.campaignId}`,
    });
    return jsonResponse(201, formatCampaign(item));
  }));

  app.get("/campaigns", async ({ event }) => {
    const tenantId = requireTenantId(event);
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
      tenantId,
    });

    return jsonResponse(200, {
      campaigns: items.map(formatCampaign),
      nextStartKey: encodeCursor(lastEvaluatedKey),
    });
  });

  app.get("/campaigns/:campaignId", async ({ event, params }) => {
    const { campaignId } = params;
    const tenantId = requireTenantId(event);
    await assertCampaignOwned(campaignId, tenantId);
    const { metadata, links, socialPosts, contentPosts, brief, draft } = await getCampaignWithLinks(campaignId);
    const briefDownloadUrl = brief?.s3Key ? await presignBriefDownload(brief.s3Key) : null;
    return jsonResponse(200, {
      campaign: formatCampaign(metadata),
      links: links.map(formatLink).sort((a, b) => a.created_at.localeCompare(b.created_at)),
      social_posts: socialPosts
        .map(formatSocialPost)
        .sort((a, b) => a.created_at.localeCompare(b.created_at)),
      content_posts: contentPosts
        .map(formatContentPost)
        .sort((a, b) => a.created_at.localeCompare(b.created_at)),
      brief: brief ? formatBrief(brief, briefDownloadUrl) : null,
      draft: draft ? formatDraft(draft) : null,
    });
  });

  // PATCH /campaigns/:campaignId
  //
  // Applies edited fields to an existing campaign. The brief-review UI
  // calls this when the user accepts a brief's suggested updates.
  app.patch("/campaigns/:campaignId", async ({ event, params }) => {
    const { campaignId } = params;
    const tenantId = requireTenantId(event);
    await assertCampaignOwned(campaignId, tenantId);
    const body = parseBody(event);
    const fields = validateCampaignUpdate(body);
    // Re-linking to a vendor has the same cross-tenant exposure as create, so
    // verify the caller owns any vendor they're pointing the campaign at.
    if (fields.vendorId) {
      await assertVendorOwned(fields.vendorId, tenantId);
    }
    applyPaidAtDefault(fields.payout);
    const updated = await updateCampaignFields(campaignId, fields);
    return jsonResponse(200, formatCampaign(updated));
  });

  // POST /campaigns/:campaignId/brief/upload-url
  //
  // Mints a 15-minute presigned PUT URL for a PDF brief. The client uploads
  // the PDF directly to S3 (avoids API Gateway's 6MB payload cap), then
  // calls POST /campaigns/:campaignId/brief with source_type=pdf.
  app.post("/campaigns/:campaignId/brief/upload-url", async ({ event, params }) => {
    const { campaignId } = params;
    const tenantId = requireTenantId(event);
    await assertCampaignOwned(campaignId, tenantId);
    requireUlid(campaignId, "campaignId");
    validateUploadUrlRequest(parseBody(event, { optional: true }));
    const { url, key, expiresAt } = await presignBriefUpload({
      campaignId,
      contentType: "application/pdf",
    });
    logger.info("Issued brief upload URL", { campaignId, key });
    return jsonResponse(201, {
      upload_url: url,
      s3_key: key,
      expires_at: expiresAt,
    });
  });

  // POST /campaigns/:campaignId/brief
  //
  // Attaches a brief to the campaign. Accepts either:
  //   { source_type: "chat", conversation: [...] }
  //   { source_type: "pdf" }   (after the upload-url flow)
  //
  // Summarizes the brief via Bedrock, stores the summary + suggested
  // campaign fields under the campaign (replacing any prior brief), and
  // returns them so the UI can offer the suggestions for the user to apply.
  app.post("/campaigns/:campaignId/brief", withIdempotency(async ({ event, params }) => {
    const { campaignId } = params;
    const tenantId = requireTenantId(event);
    await assertCampaignOwned(campaignId, tenantId);
    requireUlid(campaignId, "campaignId");
    const submission = validateBriefSubmission(parseBody(event));

    const { summary, suggested_campaign, warnings } = await attachBrief({
      campaignId,
      tenantId,
      submission,
    });

    return jsonResponse(201, {
      campaign_id: campaignId,
      source_type: submission.source_type,
      summary,
      suggested_campaign,
      warnings,
    });
  }));

  // POST /campaigns/:campaignId/draft
  //
  // Stores (or replaces) the link to the campaign's working draft —
  // almost always a Google Doc. Saving a new link clears any prior review
  // since the link now points at different content. Run the review
  // separately via POST /campaigns/:campaignId/draft/review.
  app.post("/campaigns/:campaignId/draft", withIdempotency(async ({ event, params }) => {
    const { campaignId } = params;
    const tenantId = requireTenantId(event);
    await assertCampaignOwned(campaignId, tenantId);
    requireUlid(campaignId, "campaignId");
    const { url, docId } = validateDraftSubmission(parseBody(event));
    const draft = await saveDraftForCampaign({ campaignId, url, docId });
    return jsonResponse(201, formatDraft(draft));
  }));

  // GET /campaigns/:campaignId/draft
  app.get("/campaigns/:campaignId/draft", async ({ event, params }) => {
    const { campaignId } = params;
    const tenantId = requireTenantId(event);
    await assertCampaignOwned(campaignId, tenantId);
    requireUlid(campaignId, "campaignId");
    const draft = await getDraftForCampaign(campaignId);
    if (!draft) {
      throw new NotFoundError("Draft", campaignId);
    }
    return jsonResponse(200, formatDraft(draft));
  });

  // POST /campaigns/:campaignId/draft/review
  //
  // Pulls the draft's text from Google Docs and has Bedrock review it
  // against the campaign's brief, then stores the feedback on the draft
  // and returns it. Requires both a saved draft (with a Google Docs link)
  // and an attached brief.
  app.post("/campaigns/:campaignId/draft/review", withIdempotency(async ({ event, params }) => {
    const { campaignId } = params;
    const tenantId = requireTenantId(event);
    await assertCampaignOwned(campaignId, tenantId);
    requireUlid(campaignId, "campaignId");

    const updated = await reviewCampaignDraft(campaignId);
    return jsonResponse(201, formatDraft(updated));
  }));
}