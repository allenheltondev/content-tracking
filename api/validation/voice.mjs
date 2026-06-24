import { BadRequestError } from "../services/errors.mjs";

// Validation + formatting for the Voice feature. Request/response bodies are
// snake_case; internal storage is camelCase, matching validation/blog.mjs.
// Throws BadRequestError on any rule violation so routes let it propagate to
// the error mapper.

// Platforms a voice profile can be learned for. "blog" is a first-class
// platform (the blog catalog seeds it); the rest are short-form social.
export const VOICE_PLATFORMS = [
  "blog",
  "x",
  "linkedin",
  "bluesky",
  "instagram",
  "threads",
  "mastodon",
  "medium",
  "devto",
];
export const VOICE_FORMATS = ["social", "blog"];
const SOURCES = ["manual", "generated", "blog-seed"];

const TOPIC_MAX = 2000;
const GUIDANCE_MAX = 1000;
const SAMPLE_TEXT_MAX = 20_000;

function requireObject(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequestError("request body must be a JSON object");
  }
}

// Validates a platform path/query param against the allowlist.
export function validatePlatform(value) {
  if (typeof value !== "string" || !VOICE_PLATFORMS.includes(value)) {
    throw new BadRequestError(`platform must be one of: ${VOICE_PLATFORMS.join(", ")}`);
  }
  return value;
}

// "blog" is inherently long-form, so it pins format=blog. Otherwise format is
// free (a social platform may still want a long-form "article").
function validateFormat(value, platform) {
  if (typeof value !== "string" || !VOICE_FORMATS.includes(value)) {
    throw new BadRequestError(`format must be one of: ${VOICE_FORMATS.join(", ")}`);
  }
  if (platform === "blog" && value !== "blog") {
    throw new BadRequestError('platform "blog" requires format "blog"');
  }
  return value;
}

function validateOptionalString(value, label, max) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BadRequestError(`${label} must be a non-empty string`);
  }
  if (value.length > max) {
    throw new BadRequestError(`${label} must be at most ${max} chars`);
  }
  return value.trim();
}

export function validateComposeRequest(body) {
  requireObject(body);
  const platform = validatePlatform(body.platform);
  const out = {
    topic: validateOptionalString(body.topic, "topic", TOPIC_MAX),
    platform,
    format: validateFormat(body.format, platform),
  };
  if (body.guidance !== undefined && body.guidance !== null) {
    out.guidance = validateOptionalString(body.guidance, "guidance", GUIDANCE_MAX);
  }
  return out;
}

export function validateSampleCreate(body) {
  requireObject(body);
  const platform = validatePlatform(body.platform);
  const out = {
    text: validateOptionalString(body.text, "text", SAMPLE_TEXT_MAX),
    platform,
    format: validateFormat(body.format, platform),
    source: "manual",
  };
  if (body.source !== undefined && body.source !== null) {
    if (!SOURCES.includes(body.source)) {
      throw new BadRequestError(`source must be one of: ${SOURCES.join(", ")}`);
    }
    out.source = body.source;
  }
  return out;
}

// The composed draft (not persisted).
export function formatVoiceDraft({ post, title }) {
  return { post, title: title ?? null };
}

export function formatVoiceSample(row) {
  return {
    sample_id: row.sampleId,
    platform: row.platform,
    format: row.format ?? null,
    source: row.source ?? null,
    text: row.text,
    created_at: row.createdAt,
  };
}

export function formatVoiceProfile(row) {
  if (!row) return null;
  return {
    platform: row.platform,
    profile: row.profile ?? null,
    samples_since_reflection: row.samplesSinceReflection ?? 0,
    version: row.version ?? 0,
    created_at: row.createdAt ?? null,
    updated_at: row.updatedAt ?? null,
  };
}

export function formatVoiceReflection(row) {
  return {
    reflection_id: row.reflectionId,
    platform: row.platform,
    change_summary: row.changeSummary ?? null,
    sample_window: row.sampleWindow ?? null,
    model: row.model ?? null,
    created_at: row.createdAt,
  };
}
