import { BadRequestError, NotFoundError } from "../services/errors.mjs";
import { jsonResponse, parseBody } from "../services/http-handler.mjs";
import { withIdempotency } from "../services/idempotency.mjs";
import { logger } from "../services/logger.mjs";
import { decodeCursor, encodeCursor, parseLimit } from "../services/pagination.mjs";
import {
  attachBrief,
  createCampaignFromBrief,
  reviewCampaignDraft,
  stageBriefUpload,
} from "../services/brief-pipeline.mjs";
import { presignBriefDownload, presignBriefUpload } from "../services/s3.mjs";
import {
  CAMPAIGN_STATUSES,
  formatCampaign,
  formatCampaignDetail,
  validateCampaignCreate,
  validateCampaignUpdate,
} from "../validation/campaign.mjs";
import {
  validateBriefImport,
  validateBriefSubmission,
  validateUploadUrlRequest,
} from "../validation/brief.mjs";
import { formatDraft, validateDraftSubmission } from "../validation/draft.mjs";
import { requireUlid } from "../validation/common.mjs";
import {
  assertCampaignOwned,
  getCampaignWithLinks,
  listCampaigns,
} from "../domain/campaign.mjs";
import { requireTenantId } from "../services/identity.mjs";
import { trackActivity } from "../services/activity.mjs";
import { createTenantCampaign, updateTenantCampaign } from "../services/campaign-actions.mjs";
import { getDraftForCampaign, saveDraftForCampaign } from "../domain/draft.mjs";

const VALID_STATUSES = new Set(CAMPAIGN_STATUSES);

export function registerCampaignRoutes(app) {
  app.post("/campaigns", withIdempotency(async ({ event }) => {
    const tenantId = requireTenantId(event);
    const body = parseBody(event);
    const fields = validateCampaignCreate(body);
    // Vendor ownership check + the "Deal Maker" activity live in the shared
    // service so the MCP create_campaign tool runs the same steps.
    const item = await createTenantCampaign(tenantId, fields);
    return jsonResponse(201, formatCampaign(item));
  }));

  // POST /campaigns/from-brief/upload-url
  //
  // Mints a presigned PUT URL for a brief whose campaign doesn't exist yet. The
  // client uploads straight to S3, then calls POST /campaigns/from-brief.
  app.post("/campaigns/from-brief/upload-url", async ({ event }) => {
    const tenantId = requireTenantId(event);
    const { content_type: contentType, format } = validateUploadUrlRequest(parseBody(event, { optional: true }));
    const { uploadId, url, expiresAt } = await stageBriefUpload({ tenantId, format, contentType });
    return jsonResponse(201, { upload_id: uploadId, upload_url: url, expires_at: expiresAt });
  });

  // POST /campaigns/from-brief
  //
  // Reads a staged brief and creates the campaign from it. Nothing is created
  // if the file can't be read. Dates and payout come back as brief suggestions
  // for the user to review.
  app.post("/campaigns/from-brief", withIdempotency(async ({ event }) => {
    const tenantId = requireTenantId(event);
    const submission = validateBriefImport(parseBody(event));
    const item = await createCampaignFromBrief({ tenantId, ...submission });
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
    const detail = await getCampaignWithLinks(campaignId);
    const briefDownloadUrl = detail.brief?.s3Key ? await presignBriefDownload(detail.brief.s3Key) : null;
    return jsonResponse(200, formatCampaignDetail(detail, { briefDownloadUrl }));
  });

  // PATCH /campaigns/:campaignId
  //
  // Applies edited fields to an existing campaign. The brief-review UI
  // calls this when the user accepts a brief's suggested updates.
  app.patch("/campaigns/:campaignId", async ({ event, params }) => {
    const { campaignId } = params;
    const tenantId = requireTenantId(event);
    const fields = validateCampaignUpdate(parseBody(event));
    // The dashboard's status picker is a manual override, so this route
    // writes status as given (no lifecycle check, unlike the MCP tools).
    const updated = await updateTenantCampaign(tenantId, campaignId, fields);
    return jsonResponse(200, formatCampaign(updated));
  });

  // POST /campaigns/:campaignId/brief/upload-url
  //
  // Mints a 15-minute presigned PUT URL for a brief file. The client uploads
  // the PDF directly to S3 (avoids API Gateway's 6MB payload cap), then
  // calls POST /campaigns/:campaignId/brief with the file's source_type.
  app.post("/campaigns/:campaignId/brief/upload-url", async ({ event, params }) => {
    const { campaignId } = params;
    const tenantId = requireTenantId(event);
    await assertCampaignOwned(campaignId, tenantId);
    requireUlid(campaignId, "campaignId");
    const { content_type: contentType, format } = validateUploadUrlRequest(parseBody(event, { optional: true }));
    const { url, key, expiresAt } = await presignBriefUpload({ campaignId, format, contentType });
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
  //   { source_type: "pdf" | "docx" }   (after the upload-url flow)
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