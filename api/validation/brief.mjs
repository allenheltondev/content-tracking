import { BadRequestError } from "../services/errors.mjs";
import { validatePayoutPayload } from "./payout.mjs";

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const VALID_ROLES = new Set(["vendor", "influencer", "user", "assistant"]);
const MAX_CONVERSATION_ENTRIES = 200;
const MAX_CONTENT_LEN = 10_000;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_STATUSES = new Set(["draft", "active", "completed"]);
const NAME_MAX = 200;
const SPONSOR_MAX = 200;
const PLATFORM_MAX = 64;
const TYPE_MAX = 64;
const NOTES_MAX = 1000;
const MAX_DELIVERABLES = 50;

export function validateUploadUrlRequest(body) {
  if (body === null || body === undefined) return {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new BadRequestError("request body must be a JSON object");
  }
  const { content_type } = body;
  if (content_type !== undefined) {
    if (typeof content_type !== "string") {
      throw new BadRequestError("content_type must be a string");
    }
    if (content_type !== "application/pdf") {
      throw new BadRequestError("content_type must be application/pdf");
    }
  }
  return { content_type: content_type || "application/pdf" };
}

export function validateBriefSubmission(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequestError("request body must be a JSON object");
  }
  const { source_type } = body;
  if (source_type === "chat") {
    return validateChatBrief(body);
  }
  if (source_type === "pdf") {
    return validatePdfBrief(body);
  }
  throw new BadRequestError("source_type must be 'chat' or 'pdf'");
}

function validateChatBrief(body) {
  const { conversation } = body;
  if (!Array.isArray(conversation) || conversation.length === 0) {
    throw new BadRequestError("conversation must be a non-empty array");
  }
  if (conversation.length > MAX_CONVERSATION_ENTRIES) {
    throw new BadRequestError(
      `conversation may contain at most ${MAX_CONVERSATION_ENTRIES} entries`,
    );
  }
  const normalized = [];
  for (const [i, entry] of conversation.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new BadRequestError(`conversation[${i}] must be an object`);
    }
    const role = entry.role;
    if (typeof role !== "string" || !VALID_ROLES.has(role)) {
      throw new BadRequestError(
        `conversation[${i}].role must be one of ${[...VALID_ROLES].join(", ")}`,
      );
    }
    const content = entry.content;
    if (typeof content !== "string" || content.length === 0) {
      throw new BadRequestError(`conversation[${i}].content must be a non-empty string`);
    }
    if (content.length > MAX_CONTENT_LEN) {
      throw new BadRequestError(`conversation[${i}].content exceeds ${MAX_CONTENT_LEN} chars`);
    }
    normalized.push({ role, content });
  }
  return { source_type: "chat", conversation: normalized };
}

function validatePdfBrief(body) {
  const { brief_id } = body;
  if (typeof brief_id !== "string" || !ULID_RE.test(brief_id)) {
    throw new BadRequestError("brief_id must be a ULID (call POST /briefs/upload-url first)");
  }
  return { source_type: "pdf", brief_id };
}

// Serializes a validated conversation array into a single text block
// for both Bedrock and S3 archival.
export function conversationToTranscript(conversation) {
  return conversation
    .map((entry) => `${entry.role}: ${entry.content}`)
    .join("\n\n");
}

// Validates the edited suggested_campaign payload submitted by the
// dashboard's brief intake form on POST /briefs/{briefId}/confirm.
// Combines the rules from validateCampaignCreate (name/sponsor/vendor/
// dates/status/targetMetrics) with brief-only fields (deliverables,
// payout). Returns a normalized object split into:
//   - campaignFields: ready to pass to createCampaign
//   - acceptedSuggestion: the full edited blob to persist back onto the
//     brief record as the agreed-on scope
export function validateBriefConfirm(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequestError("request body must be a JSON object");
  }

  const {
    name,
    sponsor,
    vendor_id,
    startDate,
    endDate,
    status,
    targetMetrics,
    deliverables,
    payout,
  } = body;

  if (typeof name !== "string" || name.trim().length === 0) {
    throw new BadRequestError("name is required");
  }
  if (name.length > NAME_MAX) {
    throw new BadRequestError(`name exceeds ${NAME_MAX} chars`);
  }

  const campaignFields = { name: name.trim() };
  const acceptedSuggestion = { name: name.trim() };

  if (sponsor !== undefined && sponsor !== null && sponsor !== "") {
    if (typeof sponsor !== "string" || sponsor.length > SPONSOR_MAX) {
      throw new BadRequestError(`sponsor must be a string up to ${SPONSOR_MAX} chars`);
    }
    campaignFields.sponsor = sponsor;
    acceptedSuggestion.vendor = { name_hint: sponsor };
  }

  if (vendor_id !== undefined && vendor_id !== null && vendor_id !== "") {
    if (typeof vendor_id !== "string" || !ULID_RE.test(vendor_id)) {
      throw new BadRequestError("vendor_id must be a ULID");
    }
    campaignFields.vendorId = vendor_id;
    acceptedSuggestion.vendor_id = vendor_id;
  }

  if (status !== undefined) {
    if (!VALID_STATUSES.has(status)) {
      throw new BadRequestError(`status must be one of ${[...VALID_STATUSES].join(", ")}`);
    }
    campaignFields.status = status;
  } else {
    campaignFields.status = "draft";
  }

  if (startDate !== undefined && startDate !== null && startDate !== "") {
    if (typeof startDate !== "string" || !ISO_DATE_RE.test(startDate)) {
      throw new BadRequestError("startDate must be YYYY-MM-DD");
    }
    campaignFields.startDate = startDate;
    acceptedSuggestion.startDate = startDate;
  }

  if (endDate !== undefined && endDate !== null && endDate !== "") {
    if (typeof endDate !== "string" || !ISO_DATE_RE.test(endDate)) {
      throw new BadRequestError("endDate must be YYYY-MM-DD");
    }
    campaignFields.endDate = endDate;
    acceptedSuggestion.endDate = endDate;
  }

  if (targetMetrics !== undefined && targetMetrics !== null) {
    if (typeof targetMetrics !== "object" || Array.isArray(targetMetrics)) {
      throw new BadRequestError("targetMetrics must be an object");
    }
    campaignFields.targetMetrics = targetMetrics;
    acceptedSuggestion.targetMetrics = targetMetrics;
  }

  if (deliverables !== undefined && deliverables !== null) {
    acceptedSuggestion.deliverables = validateDeliverables(deliverables);
  }

  let normalizedPayout;
  if (payout !== undefined && payout !== null) {
    normalizedPayout = validatePayoutPayload(payout, { partial: false });
    acceptedSuggestion.payout = { amount: normalizedPayout.amount, currency: normalizedPayout.currency };
  }

  return { campaignFields, acceptedSuggestion, payout: normalizedPayout };
}

function validateDeliverables(deliverables) {
  if (!Array.isArray(deliverables)) {
    throw new BadRequestError("deliverables must be an array");
  }
  if (deliverables.length > MAX_DELIVERABLES) {
    throw new BadRequestError(`deliverables may contain at most ${MAX_DELIVERABLES} entries`);
  }
  return deliverables.map((entry, i) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new BadRequestError(`deliverables[${i}] must be an object`);
    }
    const { platform, type, count, notes } = entry;
    if (typeof platform !== "string" || platform.length === 0 || platform.length > PLATFORM_MAX) {
      throw new BadRequestError(`deliverables[${i}].platform is required (1-${PLATFORM_MAX} chars)`);
    }
    if (typeof type !== "string" || type.length === 0 || type.length > TYPE_MAX) {
      throw new BadRequestError(`deliverables[${i}].type is required (1-${TYPE_MAX} chars)`);
    }
    const normalized = { platform, type };
    if (count !== undefined && count !== null) {
      if (!Number.isInteger(count) || count < 1) {
        throw new BadRequestError(`deliverables[${i}].count must be a positive integer`);
      }
      normalized.count = count;
    }
    if (notes !== undefined && notes !== null && notes !== "") {
      if (typeof notes !== "string" || notes.length > NOTES_MAX) {
        throw new BadRequestError(`deliverables[${i}].notes must be a string up to ${NOTES_MAX} chars`);
      }
      normalized.notes = notes;
    }
    return normalized;
  });
}
