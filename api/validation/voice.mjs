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
const SOURCES = ["manual", "generated", "blog-seed", "content-auto"];

// Surfaced to the UI so it can render real progress toward the next automatic
// reflection. Mirrors the ReflectionThreshold template parameter.
const REFLECTION_THRESHOLD = Number(process.env.REFLECTION_THRESHOLD ?? 5);

// Surfaced on profile reads so the UI can explain the recency model. Mirrors
// the VoiceHalfLifeDays template parameter (see services/voice-recency.mjs).
const VOICE_HALF_LIFE_DAYS = Number(process.env.VOICE_HALF_LIFE_DAYS ?? 90);

const TOPIC_MAX = 2000;
const GUIDANCE_MAX = 1000;
const SAMPLE_TEXT_MAX = 20_000;
const DRAFT_MAX = 20_000;
const STEERING_MAX = 500;

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

// POST /voice/check — grade an arbitrary draft against the learned voice. Like
// compose it needs a platform + format (which few-shot examples to pull), plus
// the draft to assess.
export function validateVoiceCheckRequest(body) {
  requireObject(body);
  const platform = validatePlatform(body.platform);
  return {
    draft: validateOptionalString(body.draft, "draft", DRAFT_MAX),
    platform,
    format: validateFormat(body.format, platform),
  };
}

// PATCH /voice/samples/{id} — currently only toggles the muted flag.
export function validateSampleUpdate(body) {
  requireObject(body);
  if (typeof body.muted !== "boolean") {
    throw new BadRequestError("muted must be a boolean");
  }
  return { muted: body.muted };
}

// PUT /voice/profiles/{platform}/steering — set (or clear with null) the intent
// note that biases the next reflection.
export function validateSteeringRequest(body) {
  requireObject(body);
  if (body.note === null) {
    return { note: null };
  }
  return { note: validateOptionalString(body.note, "note", STEERING_MAX) };
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
  // Optional publish date/time: anchors the sample on the recency-decay curve
  // (defaults to capture time when omitted). Accepts YYYY-MM-DD or full ISO
  // 8601 timestamps.
  if (body.published_at !== undefined && body.published_at !== null) {
    if (typeof body.published_at !== "string"
      || !/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(body.published_at.trim())
      || isNaN(Date.parse(body.published_at.trim()))) {
      throw new BadRequestError("published_at must be a YYYY-MM-DD date or ISO 8601 timestamp");
    }
    out.publishedAt = body.published_at.trim();
  }
  return out;
}

// The composed draft (not persisted).
export function formatVoiceDraft({ post, title }) {
  return { post, title: title ?? null };
}

// `extra.influenceShare` (0-1) is the sample's current share of the voice, when
// the caller has computed it (the samples list does; single-item responses
// don't). muted samples report 0.
export function formatVoiceSample(row, extra = {}) {
  return {
    sample_id: row.sampleId,
    platform: row.platform,
    format: row.format ?? null,
    source: row.source ?? null,
    text: row.text,
    published_at: row.publishedAt ?? null,
    created_at: row.createdAt,
    muted: row.muted === true,
    influence_share: typeof extra.influenceShare === "number"
      ? Math.round(extra.influenceShare * 100) / 100
      : null,
  };
}

export function formatVoiceProfile(row) {
  if (!row) return null;
  return {
    platform: row.platform,
    profile: row.profile ?? null,
    // The plain-English portrait lives inside the learned profile JSON; surface
    // it at the top level too so clients don't have to reach into `profile`.
    portrait: typeof row.profile?.portrait === "string" ? row.profile.portrait : null,
    // The creator's intent note that biases reflection.
    steering: row.steering ?? null,
    samples_since_reflection: row.samplesSinceReflection ?? 0,
    reflection_threshold: REFLECTION_THRESHOLD,
    recency_half_life_days: VOICE_HALF_LIFE_DAYS,
    version: row.version ?? 0,
    created_at: row.createdAt ?? null,
    updated_at: row.updatedAt ?? null,
  };
}

// One platform's entry in GET /voice/overview: the plain-English portrait plus
// corpus transparency (what the voice is listening to and how recency-weighted
// it is). `summary` is the summarizeVoiceCorpus output.
export function formatVoiceOverviewEntry({ profileRow, summary }) {
  return {
    platform: profileRow.platform,
    portrait: typeof profileRow.profile?.portrait === "string" ? profileRow.profile.portrait : null,
    steering: profileRow.steering ?? null,
    version: profileRow.version ?? 0,
    samples_since_reflection: profileRow.samplesSinceReflection ?? 0,
    reflection_threshold: REFLECTION_THRESHOLD,
    recency_half_life_days: VOICE_HALF_LIFE_DAYS,
    updated_at: profileRow.updatedAt ?? null,
    corpus: {
      // total_samples / by_source / influence cover only the eligible corpus
      // (what actually drives the voice); excluded reports the held-out counts.
      total_samples: summary.total,
      by_source: summary.bySource,
      excluded: summary.excluded ?? { muted: 0, generated: 0 },
      earliest_published: summary.earliestPublished,
      latest_published: summary.latestPublished,
      // Each horizon: the share of the current voice that comes from posts
      // published inside the window — the recency math made legible.
      recent_influence: summary.recentInfluence.map((h) => ({
        window_days: h.windowDays,
        influence_share: Math.round(h.share * 100) / 100,
        sample_count: h.sampleCount,
      })),
    },
  };
}

// POST /voice/check result. `result` is the assessVoiceMatch tool output.
export function formatVoiceAssessment(result) {
  return {
    score: result.score,
    verdict: result.verdict,
    summary: result.summary,
    strengths: result.strengths ?? [],
    issues: (result.issues ?? []).map((i) => ({
      area: i.area ?? null,
      detail: i.detail,
      suggestion: i.suggestion,
    })),
    on_voice_rewrite: result.on_voice_rewrite ?? null,
  };
}

export function formatVoiceReflection(row) {
  return {
    reflection_id: row.reflectionId,
    platform: row.platform,
    change_summary: row.changeSummary ?? null,
    sample_window: row.sampleWindow ?? null,
    half_life_days: row.halfLifeDays ?? null,
    // Snapshot of the profile version + portrait at this reflection, so the
    // reflection list reads as a "your voice over time" history.
    version: row.version ?? null,
    portrait: row.portrait ?? null,
    model: row.model ?? null,
    created_at: row.createdAt,
  };
}
