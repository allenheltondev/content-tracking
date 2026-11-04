import { BadRequestError, NotFoundError } from "./errors.mjs";
import { ulid } from "ulid";
import { logger } from "./logger.mjs";
import { reviewDraft, summarizeBrief } from "./bedrock/brief.mjs";
import { fetchGoogleDocText } from "./google-docs.mjs";
import {
  briefFileKey,
  getBriefObjectBytes,
  moveBriefObject,
  presignStagedBriefUpload,
  putBriefTranscript,
  stagedBriefKey,
} from "./s3.mjs";
import { conversationToTranscript } from "../validation/brief.mjs";
import { NAME_MAX, SPONSOR_MAX, validateCampaignCreate } from "../validation/campaign.mjs";
import { createCampaign, findCampaign } from "../domain/campaign.mjs";
import { listVendors } from "../domain/vendor.mjs";
import { getBriefForCampaign, saveBriefForCampaign } from "../domain/brief.mjs";
import { getDraftForCampaign, saveDraftReview } from "../domain/draft.mjs";

// The brief pipeline: turning a chat transcript or uploaded file into a
// stored, summarized brief, and reviewing a campaign's working draft
// against it. Moved out of routes/campaigns.mjs so the route stays HTTP
// glue and this flow is testable on its own.

// Reads an uploaded brief file, turning a missing object into a 400. The caller
// likely forgot to PUT the file before POSTing, or the upload URL expired.
async function readBriefFile(s3Key) {
  try {
    return await getBriefObjectBytes(s3Key);
  } catch (err) {
    logger.warn("Brief file not found in S3", { s3Key, error: err?.message });
    throw new BadRequestError("No uploaded brief found. Upload the file first.");
  }
}

async function listVendorContext(tenantId) {
  const { items } = await listVendors({ tenantId });
  return (items ?? []).map((v) => ({ vendorId: v.vendorId, name: v.name }));
}

// Drops a vendor_id the model made up, so nothing downstream links the campaign
// to a vendor that doesn't exist or isn't this tenant's.
function withKnownVendor(toolInput, vendors) {
  const suggested = toolInput.suggested_campaign;
  const vendorId = suggested?.vendor?.vendor_id;
  if (!vendorId || vendors.some((v) => v.vendorId === vendorId)) return toolInput;
  const { vendor_id: _unknown, ...vendor } = suggested.vendor;
  return { ...toolInput, suggested_campaign: { ...suggested, vendor } };
}

// Attaches a brief to the campaign. Accepts a validated submission of
// source_type "chat" (with conversation) or "pdf"/"docx" (after the upload-url
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
    s3Key = briefFileKey(campaignId, submission.source_type);
    bedrockInput = { sourceType: submission.source_type, documentBytes: await readBriefFile(s3Key) };
  }

  // Give the model what we already know about the campaign and the
  // vendors in our system so it can avoid re-suggesting what's set and
  // match the brief's vendor against an existing record rather than
  // fabricating a new spelling. Both are best-effort: empty list /
  // missing campaign just means the prompt has less context.
  const [existingCampaign, vendors] = await Promise.all([
    findCampaign(campaignId),
    listVendorContext(tenantId),
  ]);
  bedrockInput.existingCampaign = existingCampaign;
  bedrockInput.vendors = vendors;

  const toolInput = withKnownVendor(await summarizeBrief(bedrockInput), vendors);
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

// Mints a presigned URL for a brief whose campaign doesn't exist yet. The file
// waits under a staged key until createCampaignFromBrief claims it.
export async function stageBriefUpload({ tenantId, format, contentType }) {
  const uploadId = ulid();
  const upload = await presignStagedBriefUpload({ tenantId, uploadId, format, contentType });
  return { uploadId, ...upload };
}

function nameFromFile(fileName) {
  return fileName?.replace(/\.[^.]+$/, "").trim() || "Untitled campaign";
}

// Creates a campaign from a staged brief. The campaign is written only after
// the model has read the file, so a bad upload leaves nothing behind. Name,
// sponsor, and vendor are saved here. Dates and payout stay suggestions until
// the user reviews and applies them, since payout feeds revenue.
export async function createCampaignFromBrief({ tenantId, uploadId, sourceType, fileName }) {
  const stagedKey = stagedBriefKey(tenantId, uploadId, sourceType);
  const documentBytes = await readBriefFile(stagedKey);
  const vendors = await listVendorContext(tenantId);

  const toolInput = withKnownVendor(await summarizeBrief({ sourceType, documentBytes, vendors }), vendors);
  const { summary, suggested_campaign: suggested } = toolInput;
  const warnings = Array.isArray(toolInput.warnings) ? [...toolInput.warnings] : [];

  const fields = validateCampaignCreate({
    name: (suggested?.name || nameFromFile(fileName)).slice(0, NAME_MAX),
    sponsor: suggested?.vendor?.name_hint?.slice(0, SPONSOR_MAX),
    vendor_id: suggested?.vendor?.vendor_id,
  });
  const campaign = await createCampaign({ ...fields, tenantId });

  // The campaign can't be rolled back, and a thrown error here would make a
  // retry create a second one. The user lands on the Brief tab either way and
  // can upload again, so log and carry on.
  try {
    const s3Key = briefFileKey(campaign.campaignId, sourceType);
    await moveBriefObject({ from: stagedKey, to: s3Key });
    await saveBriefForCampaign({
      campaignId: campaign.campaignId,
      sourceType,
      s3Key,
      summary,
      suggestedCampaign: suggested,
      warnings,
    });
  } catch (err) {
    logger.error("Campaign created but its brief was not saved", {
      campaignId: campaign.campaignId,
      error: err?.message,
    });
  }

  return campaign;
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
