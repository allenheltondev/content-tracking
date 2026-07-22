import { BadRequestError, NotFoundError } from "../services/errors.mjs";
import { jsonResponse, parseBody } from "../services/http-handler.mjs";
import { withIdempotency } from "../services/idempotency.mjs";
import { logger } from "../services/logger.mjs";
import { decodeCursor, encodeCursor, parseLimit } from "../services/pagination.mjs";
import { reviewDraft, summarizeBrief } from "../services/bedrock.mjs";
import { fetchGoogleDocText } from "../services/google-docs.mjs";
import {
  getBriefObjectBytes,
  presignBriefDownload,
  presignBriefUpload,
  putBriefTranscript,
} from "../services/s3.mjs";
import { formatCampaign, validateCampaignCreate, validateCampaignUpdate } from "../validation/campaign.mjs";
import {
  conversationToTranscript,
  validateBriefSubmission,
  validateUploadUrlRequest,
} from "../validation/brief.mjs";
import { validateDraftSubmission } from "../validation/draft.mjs";
import { applyPaidAtDefault } from "../validation/payout.mjs";
import {
  assertCampaignOwned,
  createCampaign,
  findCampaign,
  getCampaignWithLinks,
  listCampaigns,
  updateCampaignFields,
} from "../domain/campaign.mjs";
import { requireTenantId } from "../services/identity.mjs";
import { trackActivity } from "../services/activity.mjs";
import { assertVendorOwned, listVendors } from "../domain/vendor.mjs";
import { getBriefForCampaign, saveBriefForCampaign } from "../domain/brief.mjs";
import {
  getDraftForCampaign,
  saveDraftForCampaign,
  saveDraftReview,
} from "../domain/draft.mjs";
import { formatSocialPost } from "../validation/social-post.mjs";
import { formatContentPost } from "../validation/content-post.mjs";

const VALID_STATUSES = new Set(["draft", "active", "monitoring", "completed"]);
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

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

    let s3Key;
    let bedrockInput;
    if (submission.source_type === "chat") {
      const transcript = conversationToTranscript(submission.conversation);
      s3Key = await putBriefTranscript({ campaignId, body: transcript });
      bedrockInput = { sourceType: "chat", text: transcript };
    } else {
      s3Key = `uploads/${campaignId}.pdf`;
      let pdfBytes;
      try {
        pdfBytes = await getBriefObjectBytes(s3Key);
      } catch (err) {
        // The caller likely forgot to PUT the PDF before POSTing, or the
        // upload URL expired. Surface as 400 with the cause.
        logger.warn("Brief PDF not found in S3", { campaignId, error: err?.message });
        throw new BadRequestError(
          `No PDF found at ${s3Key}. Upload to the presigned URL first.`,
        );
      }
      bedrockInput = { sourceType: "pdf", pdfBytes };
    }

    // Give the model what we already know about the campaign and the
    // vendors in our system so it can avoid re-suggesting what's set and
    // match the brief's vendor against an existing record rather than
    // fabricating a new spelling. Both are best-effort: empty list /
    // missing campaign just means the prompt has less context.
    const [existingCampaign, vendorList] = await Promise.all([
      findCampaign(campaignId),
      listVendors({ tenantId }),
    ]);
    bedrockInput.existingCampaign = existingCampaign;
    bedrockInput.vendors = (vendorList.items ?? []).map((v) => ({
      vendorId: v.vendorId,
      name: v.name,
    }));

    // Let exceptions propagate. We're inside withIdempotency, which caches
    // *return values*, not thrown errors — returning a 502 here would pin
    // every retry with the same Idempotency-Key to the stale failure for
    // the full TTL. Throwing lets http-handler map UpstreamError → 502 and
    // the idempotency record gets cleaned up so the next retry re-runs.
    const toolInput = await summarizeBrief(bedrockInput);
    const { summary, suggested_campaign } = toolInput;
    const warnings = Array.isArray(toolInput.warnings) ? [...toolInput.warnings] : [];

    await saveBriefForCampaign({
      campaignId,
      sourceType: submission.source_type,
      s3Key,
      summary,
      suggestedCampaign: suggested_campaign,
      warnings,
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

    const draft = await getDraftForCampaign(campaignId);
    if (!draft) {
      throw new NotFoundError("Draft", campaignId);
    }
    if (!draft.docId) {
      throw new BadRequestError("Draft review currently supports Google Docs links only.");
    }

    const brief = await getBriefForCampaign(campaignId);
    if (!brief) {
      throw new BadRequestError("Attach a brief to this campaign before reviewing its draft.");
    }

    // Fetch + Bedrock errors propagate (BadRequestError / UpstreamError).
    // As with the brief flow, throwing lets withIdempotency drop the
    // record so a retry re-runs rather than pinning the failure.
    const draftText = await fetchGoogleDocText(draft.docId);
    const review = await reviewDraft({ brief, draftText });
    const updated = await saveDraftReview(campaignId, review);

    logger.info("Draft reviewed", { campaignId, verdict: review?.verdict });
    return jsonResponse(201, formatDraft(updated));
  }));
}

function requireUlid(value, field) {
  if (!value || !ULID_RE.test(value)) {
    throw new BadRequestError(`${field} must be a ULID`);
  }
}