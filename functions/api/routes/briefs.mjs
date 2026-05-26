import { ulid } from "ulid";
import { BadRequestError } from "../services/errors.mjs";
import { jsonResponse } from "../services/http-handler.mjs";
import { withIdempotency } from "../services/idempotency.mjs";
import { logger } from "../services/logger.mjs";
import {
  getBriefObjectBytes,
  presignBriefDownload,
  presignBriefUpload,
  putBriefTranscript,
} from "../services/s3.mjs";
import { summarizeBrief } from "../services/bedrock.mjs";
import {
  createBriefRecord,
  getBriefWithCampaign,
  persistBriefSummary,
} from "../domain/brief.mjs";
import {
  conversationToTranscript,
  validateBriefSubmission,
  validateUploadUrlRequest,
} from "../validation/brief.mjs";

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function registerBriefRoutes(app) {
  // POST /briefs/upload-url
  //
  // Mints a 15-minute presigned PUT URL for a PDF brief. The client uses
  // it to upload directly to S3 (avoids the 6MB Lambda payload limit on
  // multipart through API Gateway). Returns the brief_id the client then
  // passes to POST /briefs.
  app.post("/briefs/upload-url", async ({ event }) => {
    const body = parseBody(event, { optional: true });
    validateUploadUrlRequest(body);
    const briefId = ulid();
    const { url, key, expiresAt } = await presignBriefUpload({
      briefId,
      contentType: "application/pdf",
    });
    logger.info("Issued upload URL", { briefId, key });
    return jsonResponse(201, {
      brief_id: briefId,
      upload_url: url,
      s3_key: key,
      expires_at: expiresAt,
    });
  });

  // POST /briefs
  //
  // The pipeline. Accepts either:
  //   { source_type: "chat", conversation: [...] }
  //   { source_type: "pdf",  brief_id: "..." }    (the upload-url flow)
  //
  // For chat: writes the transcript to S3 as the canonical raw artifact,
  // then calls Bedrock with the text.
  // For pdf: reads the S3 object the client uploaded, passes the bytes
  // to Bedrock as a document content block.
  //
  // Optional ?createDraft=true also creates a draft Campaign linked to
  // the brief, transactionally with the brief record write.
  app.post("/briefs", withIdempotency(async ({ event }) => {
    const body = parseBody(event);
    const submission = validateBriefSubmission(body);
    const createDraft = event.queryStringParameters?.createDraft === "true";

    let briefId;
    let s3Key;
    let bedrockInput;

    if (submission.source_type === "chat") {
      briefId = ulid();
      const transcript = conversationToTranscript(submission.conversation);
      s3Key = await putBriefTranscript({ briefId, body: transcript });
      bedrockInput = { sourceType: "chat", text: transcript };
    } else {
      briefId = submission.brief_id;
      s3Key = `uploads/${briefId}.pdf`;
      let pdfBytes;
      try {
        pdfBytes = await getBriefObjectBytes(s3Key);
      } catch (err) {
        // Likely the caller forgot to PUT the PDF before POSTing /briefs,
        // or the upload URL expired. Surface as 400 with the cause.
        logger.warn("Brief PDF not found in S3", { briefId, error: err?.message });
        throw new BadRequestError(
          `No PDF found at ${s3Key}. Upload to the presigned URL first.`,
        );
      }
      bedrockInput = { sourceType: "pdf", pdfBytes };
    }

    // Let exceptions propagate. We're inside a withIdempotency wrapper,
    // and Powertools caches *return values*, not thrown errors. Returning
    // a 502 response from here would pin every retry with the same
    // Idempotency-Key to the same stale failure for the full TTL.
    // Throwing instead lets the http-handler map UpstreamError → 502
    // and the idempotency record gets cleaned up so the next retry
    // actually re-runs. The raw model output (when present on the
    // UpstreamError) is logged in services/bedrock.mjs for debugging.
    const toolInput = await summarizeBrief(bedrockInput);

    const { summary, suggested_campaign } = toolInput;
    const warnings = Array.isArray(toolInput.warnings) ? [...toolInput.warnings] : [];

    // Optional draft Campaign creation. Mapping mirrors the Campaign
    // shape used by POST /campaigns so the client can later promote
    // the draft via PUT (when that route exists).
    let campaignDraft;
    let campaignId;
    if (createDraft) {
      campaignId = ulid();
      const now = new Date().toISOString();
      campaignDraft = {
        pk: `CAMPAIGN#${campaignId}`,
        sk: "METADATA",
        entity: "Campaign",
        campaignId,
        name: suggested_campaign?.name ?? "Untitled (from brief)",
        status: "draft",
        gsi1pk: "CAMPAIGNS",
        gsi1sk: `${now}#${campaignId}`,
        createdAt: now,
        // Carry the vendor name hint forward as a sponsor string; the
        // user can resolve it to a real vendor_id later. We don't try
        // to look up an existing vendor here — too easy to mismatch
        // on fuzzy names.
        sponsor: suggested_campaign?.vendor?.name_hint ?? undefined,
        startDate: suggested_campaign?.startDate ?? undefined,
        endDate: suggested_campaign?.endDate ?? undefined,
        targetMetrics: suggested_campaign?.targetMetrics ?? undefined,
        briefId,
      };
      const normalizedPayout = normalizeModelPayout(suggested_campaign?.payout, warnings);
      if (normalizedPayout) {
        campaignDraft.payout = normalizedPayout;
      }
    }

    if (createDraft) {
      await createBriefRecord({
        briefId,
        sourceType: submission.source_type,
        s3Key,
        summary,
        suggestedCampaign: suggested_campaign,
        warnings: warnings ?? [],
        campaignDraft,
      });
    } else {
      await persistBriefSummary({
        briefId,
        sourceType: submission.source_type,
        s3Key,
        summary,
        suggestedCampaign: suggested_campaign,
        warnings: warnings ?? [],
      });
    }

    return jsonResponse(201, {
      brief_id: briefId,
      source_type: submission.source_type,
      summary,
      suggested_campaign,
      warnings: warnings ?? [],
      campaign_id: campaignId ?? null,
    });
  }));

  // GET /briefs/:briefId
  //
  // Audit view. Returns the brief metadata + a presigned download URL
  // for the original PDF / transcript so the client can show "this is
  // what we summarized."
  app.get("/briefs/:briefId", async ({ event }) => {
    const { briefId } = event.pathParameters ?? {};
    if (!briefId || !ULID_RE.test(briefId)) {
      throw new BadRequestError("briefId must be a ULID");
    }
    const { metadata, campaignId } = await getBriefWithCampaign(briefId);
    const downloadUrl = metadata.s3Key
      ? await presignBriefDownload(metadata.s3Key)
      : null;

    return jsonResponse(200, {
      brief_id: metadata.briefId,
      source_type: metadata.sourceType,
      summary: metadata.summary,
      suggested_campaign: metadata.suggestedCampaign,
      warnings: metadata.warnings ?? [],
      campaign_id: campaignId,
      raw: downloadUrl ? { download_url: downloadUrl } : null,
      created_at: metadata.createdAt,
    });
  });
}

function parseBody(event, { optional = false } = {}) {
  if (!event.body) {
    if (optional) return {};
    throw new BadRequestError("Missing request body");
  }
  try {
    return JSON.parse(event.body);
  } catch {
    throw new BadRequestError("Invalid JSON body");
  }
}

// Sanitizes a payout object produced by Bedrock before persisting it on a
// draft Campaign. The downstream /revenue rollup exact-matches "USD" and
// the existing payout validator only accepts ISO 4217 uppercase codes, so
// model output that's lowercase, mistyped, or missing entirely would
// silently dropped from rollups later. Anything we change gets surfaced
// to the caller via the warnings array so they can fix it.
//
// Returns null if the payout is unusable (amount missing/invalid).
const CURRENCY_RE = /^[A-Z]{3}$/;
function normalizeModelPayout(rawPayout, warnings) {
  if (!rawPayout || typeof rawPayout !== "object") {
    return null;
  }

  const { amount } = rawPayout;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
    if (amount !== undefined) {
      warnings.push(`Model returned non-numeric payout.amount (${JSON.stringify(amount)}); dropped from draft.`);
    }
    return null;
  }

  let currency = "USD";
  if (rawPayout.currency !== undefined && rawPayout.currency !== null) {
    if (typeof rawPayout.currency === "string") {
      const upper = rawPayout.currency.toUpperCase().trim();
      if (CURRENCY_RE.test(upper)) {
        currency = upper;
      } else {
        warnings.push(`Model returned invalid payout.currency "${rawPayout.currency}"; defaulted to USD.`);
      }
    } else {
      warnings.push(`Model returned non-string payout.currency (${JSON.stringify(rawPayout.currency)}); defaulted to USD.`);
    }
  }

  return { amount, currency, paid: false };
}
