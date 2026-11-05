import { BadRequestError } from "../services/errors.mjs";
import { requireUlid } from "./common.mjs";

const VALID_ROLES = new Set(["vendor", "influencer", "user", "assistant"]);
const MAX_CONVERSATION_ENTRIES = 200;
const MAX_CONTENT_LEN = 10_000;
const FILE_NAME_MAX = 255;
const DEFAULT_CONTENT_TYPE = "application/pdf";

// Uploadable brief files. The format doubles as the file extension, the brief's
// source_type, and the Bedrock document format.
const FORMAT_BY_CONTENT_TYPE = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};
const FILE_FORMATS = new Set(Object.values(FORMAT_BY_CONTENT_TYPE));

export function validateUploadUrlRequest(body) {
  if (body === null || body === undefined) {
    return { content_type: DEFAULT_CONTENT_TYPE, format: FORMAT_BY_CONTENT_TYPE[DEFAULT_CONTENT_TYPE] };
  }
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new BadRequestError("request body must be a JSON object");
  }
  const { content_type } = body;
  if (content_type !== undefined) {
    if (typeof content_type !== "string") {
      throw new BadRequestError("content_type must be a string");
    }
    if (!FORMAT_BY_CONTENT_TYPE[content_type]) {
      throw new BadRequestError("content_type must be a PDF or a .docx Word document");
    }
  }
  const resolved = content_type || DEFAULT_CONTENT_TYPE;
  return { content_type: resolved, format: FORMAT_BY_CONTENT_TYPE[resolved] };
}

// The body of POST /campaigns/from-brief, sent after the file is uploaded to
// the staged URL.
export function validateBriefImport(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequestError("request body must be a JSON object");
  }
  const { upload_id, source_type, file_name } = body;
  requireUlid(upload_id, "upload_id");
  if (!FILE_FORMATS.has(source_type)) {
    throw new BadRequestError("source_type must be 'pdf' or 'docx'");
  }
  if (file_name !== undefined && (typeof file_name !== "string" || file_name.length > FILE_NAME_MAX)) {
    throw new BadRequestError(`file_name must be a string up to ${FILE_NAME_MAX} chars`);
  }
  return { uploadId: upload_id, sourceType: source_type, fileName: file_name };
}

export function validateBriefSubmission(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequestError("request body must be a JSON object");
  }
  const { source_type } = body;
  if (source_type === "chat") {
    return validateChatBrief(body);
  }
  if (FILE_FORMATS.has(source_type)) {
    // The file lives at uploads/{campaignId}.{format} (the campaign-scoped
    // upload-url flow), so the submission body carries no id of its own.
    return { source_type };
  }
  throw new BadRequestError("source_type must be 'chat', 'pdf', or 'docx'");
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

// Serializes a validated conversation array into a single text block
// for both Bedrock and S3 archival.
export function conversationToTranscript(conversation) {
  return conversation
    .map((entry) => `${entry.role}: ${entry.content}`)
    .join("\n\n");
}

// Shapes a stored brief row for responses. `downloadUrl` is a presigned link
// to the original file, when the caller minted one.
export function formatBrief(row, downloadUrl = null) {
  return {
    source_type: row.sourceType,
    summary: row.summary,
    suggested_campaign: row.suggestedCampaign ?? {},
    warnings: row.warnings ?? [],
    raw: downloadUrl ? { download_url: downloadUrl } : null,
    created_at: row.createdAt,
  };
}
