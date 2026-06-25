import { BadRequestError } from "../services/errors.mjs";

// Validation + formatting for the Content entity. Request/response bodies are
// snake_case; internal storage is camelCase (matching validation/blog.mjs).
// Throws BadRequestError on any rule violation so route handlers can let it
// propagate to the error mapper. This entity mirrors validation/blog.mjs.

const TITLE_MAX = 300;
const SLUG_MAX = 200;
const DESCRIPTION_MAX = 1000;
const URL_MAX = 1000;
const TAG_MAX = 50;
const TAGS_MAX_COUNT = 30;
const CAMPAIGN_ID_MAX = 64;
// contentMarkdown is stored on the content item; keep it well under the
// DynamoDB 400KB item limit once keys + metadata are added.
const CONTENT_MAX = 300_000;

export const CONTENT_TYPES = ["blog", "social", "video"];
export const CONTENT_SOURCES = ["owned", "sponsored"];
export const CONTENT_STATUSES = ["draft", "scheduled", "published", "archived"];

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CAMPAIGN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function requireObject(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequestError("request body must be a JSON object");
  }
}

function validateTitle(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BadRequestError("title must be a non-empty string");
  }
  if (value.length > TITLE_MAX) {
    throw new BadRequestError(`title must be at most ${TITLE_MAX} chars`);
  }
  return value.trim();
}

function validateSlug(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > SLUG_MAX || !SLUG_RE.test(value)) {
    throw new BadRequestError(
      `slug must be a kebab-case string (lowercase letters, digits, hyphens) up to ${SLUG_MAX} chars`,
    );
  }
  return value;
}

function validateContentMarkdown(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BadRequestError("content_markdown must be a non-empty string");
  }
  if (value.length > CONTENT_MAX) {
    throw new BadRequestError(`content_markdown must be at most ${CONTENT_MAX} chars`);
  }
  return value;
}

function validateType(value) {
  if (typeof value !== "string" || !CONTENT_TYPES.includes(value)) {
    throw new BadRequestError(`type must be one of ${CONTENT_TYPES.join(", ")}`);
  }
  return value;
}

function validateSource(value) {
  if (typeof value !== "string" || !CONTENT_SOURCES.includes(value)) {
    throw new BadRequestError(`source must be one of ${CONTENT_SOURCES.join(", ")}`);
  }
  return value;
}

function validateStatus(value) {
  if (typeof value !== "string" || !CONTENT_STATUSES.includes(value)) {
    throw new BadRequestError(`status must be one of ${CONTENT_STATUSES.join(", ")}`);
  }
  return value;
}

function validateUrl(value, label) {
  if (typeof value !== "string" || value.length > URL_MAX) {
    throw new BadRequestError(`${label} must be a string up to ${URL_MAX} chars`);
  }
  if (!/^https?:\/\//i.test(value)) {
    throw new BadRequestError(`${label} must start with http:// or https://`);
  }
  return value;
}

function validateTagArray(value, label) {
  if (!Array.isArray(value)) {
    throw new BadRequestError(`${label} must be an array of strings`);
  }
  if (value.length > TAGS_MAX_COUNT) {
    throw new BadRequestError(`${label} may contain at most ${TAGS_MAX_COUNT} entries`);
  }
  for (const t of value) {
    if (typeof t !== "string" || t.trim().length === 0 || t.length > TAG_MAX) {
      throw new BadRequestError(`each ${label} entry must be a non-empty string up to ${TAG_MAX} chars`);
    }
  }
  return value;
}

function validateCampaignId(value) {
  if (typeof value !== "string" || !CAMPAIGN_ID_RE.test(value)) {
    throw new BadRequestError(`campaign_id must be 1-${CAMPAIGN_ID_MAX} characters of letters, digits, underscores, or hyphens`);
  }
  return value;
}

// Optional fields shared by create + update. `update` toggles null-to-clear
// semantics (null means "remove this field" on a PATCH). On create, null is
// rejected for fields that take it (use omission instead).
function applyOptionalFields(out, body, { update }) {
  const clearable = (key, outKey, validate) => {
    const value = body[key];
    if (value === undefined) return;
    if (value === null) {
      if (!update) throw new BadRequestError(`${key} cannot be null`);
      out[outKey] = null;
      return;
    }
    out[outKey] = validate(value);
  };

  clearable("description", "description", (v) => {
    if (typeof v !== "string" || v.length > DESCRIPTION_MAX) {
      throw new BadRequestError(`description must be a string up to ${DESCRIPTION_MAX} chars`);
    }
    return v;
  });
  clearable("canonical_url", "canonicalUrl", (v) => validateUrl(v, "canonical_url"));
  clearable("tags", "tags", (v) => validateTagArray(v, "tags"));
  clearable("categories", "categories", (v) => validateTagArray(v, "categories"));
  clearable("campaign_id", "campaignId", validateCampaignId);
}

export function validateContentCreate(body) {
  requireObject(body);

  if (body.title === undefined) throw new BadRequestError("title is required");
  if (body.type === undefined) throw new BadRequestError("type is required");
  if (body.slug === undefined) throw new BadRequestError("slug is required");
  if (body.content_markdown === undefined) throw new BadRequestError("content_markdown is required");

  const out = {
    title: validateTitle(body.title),
    type: validateType(body.type),
    slug: validateSlug(body.slug),
    contentMarkdown: validateContentMarkdown(body.content_markdown),
    // source + status carry sensible defaults so a minimal create is valid.
    source: body.source === undefined ? "owned" : validateSource(body.source),
    status: body.status === undefined ? "draft" : validateStatus(body.status),
  };
  applyOptionalFields(out, body, { update: false });
  return out;
}

export function validateContentUpdate(body) {
  requireObject(body);

  const out = {};
  if (body.title !== undefined) out.title = validateTitle(body.title);
  if (body.type !== undefined) out.type = validateType(body.type);
  if (body.slug !== undefined) out.slug = validateSlug(body.slug);
  if (body.content_markdown !== undefined) out.contentMarkdown = validateContentMarkdown(body.content_markdown);
  if (body.source !== undefined) out.source = validateSource(body.source);
  if (body.status !== undefined) out.status = validateStatus(body.status);
  applyOptionalFields(out, body, { update: true });
  return out;
}

// Full representation (single-content reads). links carries the canonical URL
// and per-platform copy URLs; ids (per-platform post ids) stay internal.
export function formatContent(row) {
  return {
    content_id: row.contentId,
    type: row.type ?? null,
    source: row.source ?? null,
    title: row.title,
    slug: row.slug,
    description: row.description ?? null,
    status: row.status ?? null,
    tags: row.tags ?? [],
    categories: row.categories ?? [],
    canonical_url: row.canonicalUrl ?? null,
    content_markdown: row.contentMarkdown ?? null,
    campaign_id: row.campaignId ?? null,
    links: row.links ?? {},
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

// List representation: omits content_markdown so a content list doesn't ship
// every item's full body.
export function formatContentSummary(row) {
  const { content_markdown, ...summary } = formatContent(row);
  return summary;
}
