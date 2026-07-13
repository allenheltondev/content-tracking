import { BadRequestError } from "../services/errors.mjs";

// Validation + formatting for the Blog entity. Request/response bodies are
// snake_case; internal storage is camelCase (matching validation/vendor.mjs
// and validation/campaign.mjs). Throws BadRequestError on any rule
// violation so route handlers can let it propagate to the error mapper.

const TITLE_MAX = 300;
const SLUG_MAX = 200;
const DESCRIPTION_MAX = 1000;
const URL_MAX = 1000;
const ATTRIBUTION_MAX = 300;
const TAG_MAX = 50;
const TAGS_MAX_COUNT = 30;
const CAMPAIGN_ID_MAX = 64;
// contentMarkdown is stored on the blog item; keep it well under the
// DynamoDB 400KB item limit once keys + metadata are added.
const CONTENT_MAX = 300_000;

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
  clearable("image", "image", (v) => validateUrl(v, "image"));
  clearable("image_attribution", "imageAttribution", (v) => {
    if (typeof v !== "string" || v.length > ATTRIBUTION_MAX) {
      throw new BadRequestError(`image_attribution must be a string up to ${ATTRIBUTION_MAX} chars`);
    }
    return v;
  });
  clearable("canonical_url", "canonicalUrl", (v) => validateUrl(v, "canonical_url"));
  clearable("tags", "tags", (v) => validateTagArray(v, "tags"));
  clearable("categories", "categories", (v) => validateTagArray(v, "categories"));
  clearable("campaign_id", "campaignId", validateCampaignId);
}

export function validateBlogCreate(body) {
  requireObject(body);

  if (body.title === undefined) throw new BadRequestError("title is required");
  if (body.slug === undefined) throw new BadRequestError("slug is required");
  if (body.content_markdown === undefined) throw new BadRequestError("content_markdown is required");

  const out = {
    title: validateTitle(body.title),
    slug: validateSlug(body.slug),
    contentMarkdown: validateContentMarkdown(body.content_markdown),
  };
  applyOptionalFields(out, body, { update: false });
  return out;
}

export function validateBlogUpdate(body) {
  requireObject(body);

  const out = {};
  if (body.title !== undefined) out.title = validateTitle(body.title);
  if (body.slug !== undefined) out.slug = validateSlug(body.slug);
  if (body.content_markdown !== undefined) out.contentMarkdown = validateContentMarkdown(body.content_markdown);
  applyOptionalFields(out, body, { update: true });
  return out;
}

// Full representation (single-blog reads). links carries the canonical URL
// and per-platform copy URLs; ids (per-platform post ids) stay internal.
export function formatBlog(row) {
  return {
    blog_id: row.blogId,
    title: row.title,
    slug: row.slug,
    description: row.description ?? null,
    image: row.image ?? null,
    image_attribution: row.imageAttribution ?? null,
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

// List representation: omits content_markdown so a blog list doesn't ship
// every post's full body.
export function formatBlogSummary(row) {
  const { content_markdown, ...summary } = formatBlog(row);
  return summary;
}

const PLATFORMS = ["dev", "medium", "hashnode"];
const STAGGER_DAYS_MAX = 30;
// The last platform publishes at (platforms.length - 1) * stagger_days days.
// That whole span must finish inside the CrosspostFunction's durable
// ExecutionTimeout (30 days in template.yaml); cap the span below it with
// headroom so an accepted schedule can't time out before the last publish.
const MAX_TOTAL_STAGGER_DAYS = 28;

// Validates POST /blogs/{id}/crosspost. Returns { platforms, staggerDays }.
// staggerDays (optional) spaces the platforms apart; absent = all immediate.
export function validateCrosspostRequest(body) {
  requireObject(body);

  const { platforms, stagger_days } = body;
  if (!Array.isArray(platforms) || platforms.length === 0) {
    throw new BadRequestError("platforms must be a non-empty array");
  }
  const seen = new Set();
  for (const p of platforms) {
    if (!PLATFORMS.includes(p)) {
      throw new BadRequestError(`platforms must be a subset of ${PLATFORMS.join(", ")}`);
    }
    if (seen.has(p)) {
      throw new BadRequestError(`duplicate platform "${p}"`);
    }
    seen.add(p);
  }

  const out = { platforms };
  if (stagger_days !== undefined && stagger_days !== null) {
    if (!Number.isInteger(stagger_days) || stagger_days < 1 || stagger_days > STAGGER_DAYS_MAX) {
      throw new BadRequestError(`stagger_days must be an integer between 1 and ${STAGGER_DAYS_MAX}`);
    }
    const spanDays = (platforms.length - 1) * stagger_days;
    if (spanDays > MAX_TOTAL_STAGGER_DAYS) {
      throw new BadRequestError(
        `a staggered schedule spanning ${spanDays} days exceeds the ${MAX_TOTAL_STAGGER_DAYS}-day limit; reduce stagger_days or the number of platforms`,
      );
    }
    out.staggerDays = stagger_days;
  }
  return out;
}

const QUESTION_MAX = 2000;
const QA_TOP_K_MAX = 20;
const QA_TOP_K_DEFAULT = 8;

// Validates POST /blogs/ask. Returns { question, topK, blogId? }. top_k bounds
// how many chunks feed the model; blog_id (optional) scopes the search to one
// post instead of the whole catalog.
export function validateBlogQuestion(body) {
  requireObject(body);

  const { question, top_k, blog_id } = body;
  if (typeof question !== "string" || question.trim().length === 0) {
    throw new BadRequestError("question must be a non-empty string");
  }
  if (question.length > QUESTION_MAX) {
    throw new BadRequestError(`question must be at most ${QUESTION_MAX} chars`);
  }

  const out = { question: question.trim(), topK: QA_TOP_K_DEFAULT };

  if (top_k !== undefined && top_k !== null) {
    if (!Number.isInteger(top_k) || top_k < 1 || top_k > QA_TOP_K_MAX) {
      throw new BadRequestError(`top_k must be an integer between 1 and ${QA_TOP_K_MAX}`);
    }
    out.topK = top_k;
  }

  if (blog_id !== undefined && blog_id !== null) {
    if (typeof blog_id !== "string" || blog_id.length === 0 || blog_id.length > CAMPAIGN_ID_MAX) {
      throw new BadRequestError(`blog_id must be a string up to ${CAMPAIGN_ID_MAX} chars`);
    }
    out.blogId = blog_id;
  }

  return out;
}

// Shapes the RAG answer response. `citations` is the resolved, deduped set of
// posts the answer drew on.
export function formatBlogAnswer({ answer, confidence, citations }) {
  return {
    answer,
    confidence,
    sources: (citations ?? []).map((c) => ({
      blog_id: c.blogId,
      title: c.title ?? null,
      slug: c.slug ?? null,
    })),
  };
}
