import { BadRequestError } from "../services/errors.mjs";

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const VALID_ROLES = new Set(["vendor", "influencer", "user", "assistant"]);
const MAX_CONVERSATION_ENTRIES = 200;
const MAX_CONTENT_LEN = 10_000;

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
