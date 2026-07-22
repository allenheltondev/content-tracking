import { BadRequestError, NotFoundError } from "./errors.mjs";
import { logger } from "./logger.mjs";
import { reviewDraft, summarizeBrief } from "./bedrock/brief.mjs";
import { fetchGoogleDocText } from "./google-docs.mjs";
import { getBriefObjectBytes, putBriefTranscript } from "./s3.mjs";
import { conversationToTranscript } from "../validation/brief.mjs";
import { findCampaign } from "../domain/campaign.mjs";
import { listVendors } from "../domain/vendor.mjs";
import { getBriefForCampaign, saveBriefForCampaign } from "../domain/brief.mjs";
import { getDraftForCampaign, saveDraftReview } from "../domain/draft.mjs";

// The brief pipeline: turning a chat transcript or uploaded PDF into a
// stored, summarized brief, and reviewing a campaign's working draft
// against it. Moved out of routes/campaigns.mjs so the route stays HTTP
// glue and this flow is testable on its own.

// Attaches a brief to the campaign. Accepts a validated submission of
// source_type "chat" (with conversation) or "pdf" (after the upload-url
// flow). Summarizes via Bedrock, stores the summary + suggested campaign
// fields (replacing any prior brief), and returns what the route echoes
// back. Bedrock/S3 errors propagate — the route runs inside
// withIdempotency, which caches return values, not thrown errors, so
// throwing lets a retry re-run instead of pinning the failure.
export async function attachBrief({ campaignId, tenantId, submission }) {
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

  return { summary, suggested_campaign, warnings };
}

// Reviews the campaign's working draft against its brief: pulls the
// draft's text from Google Docs, has Bedrock review it, stores the
// feedback on the draft, and returns the updated draft row. Requires a
// saved draft with a Google Docs link and an attached brief.
export async function reviewCampaignDraft(campaignId) {
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

  // Fetch + Bedrock errors propagate (BadRequestError / UpstreamError) —
  // same idempotency reasoning as attachBrief.
  const draftText = await fetchGoogleDocText(draft.docId);
  const review = await reviewDraft({ brief, draftText });
  const updated = await saveDraftReview(campaignId, review);

  logger.info("Draft reviewed", { campaignId, verdict: review?.verdict });
  return updated;
}
