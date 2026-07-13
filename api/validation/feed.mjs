import { BadRequestError } from "../services/errors.mjs";
import { isPublicHttpUrl } from "../services/content-fetch.mjs";
import { VOICE_PLATFORMS } from "./voice.mjs";

// Validation + formatting for Content Radar (customizable RSS feeds → AI
// content angles). Request/response bodies are snake_case; internal storage is
// camelCase, matching validation/voice.mjs and validation/blog.mjs. Throws
// BadRequestError on any rule violation so routes let it propagate to the
// error mapper.

const URL_MAX = 2000;
const TITLE_MAX = 200;
const GUIDANCE_MAX = 1000;
const TOPIC_MAX = 120;
const TOPIC_LIST_MAX = 30;
const AUDIENCE_MAX = 500;

// How many aggregated feed items the ideas agent reads. Enough to see what's
// trending across sources without ballooning the prompt.
export const IDEAS_ITEM_DEFAULT = 40;
export const IDEAS_ITEM_MAX = 60;

function requireObject(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequestError("request body must be a JSON object");
  }
}

// Feed URLs must be public http(s): the server fetches them (see
// services/rss.mjs), so an internal/loopback/metadata target is both useless
// and an SSRF risk. isPublicHttpUrl is the same guard content-fetch uses.
function validateFeedUrl(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BadRequestError("url must be a non-empty string");
  }
  const url = value.trim();
  if (url.length > URL_MAX) {
    throw new BadRequestError(`url must be at most ${URL_MAX} chars`);
  }
  if (!isPublicHttpUrl(url)) {
    throw new BadRequestError("url must be a public http(s) feed URL");
  }
  return url;
}

function validateOptionalTitle(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BadRequestError("title must be a non-empty string");
  }
  if (value.length > TITLE_MAX) {
    throw new BadRequestError(`title must be at most ${TITLE_MAX} chars`);
  }
  return value.trim();
}

// POST /content-radar/feeds — add a source. url required, title optional.
export function validateFeedCreate(body) {
  requireObject(body);
  const out = { url: validateFeedUrl(body.url) };
  if (body.title !== undefined && body.title !== null) {
    out.title = validateOptionalTitle(body.title);
  }
  return out;
}

// PATCH /content-radar/feeds/{feedId} — rename (title) and/or mute. At least
// one field must be present. title:null clears the label; muted toggles
// whether the source is included in the aggregate and idea generation.
export function validateFeedUpdate(body) {
  requireObject(body);
  const out = {};
  if (body.title !== undefined) {
    out.title = body.title === null ? null : validateOptionalTitle(body.title);
  }
  if (body.muted !== undefined) {
    if (typeof body.muted !== "boolean") {
      throw new BadRequestError("muted must be a boolean");
    }
    out.muted = body.muted;
  }
  if (Object.keys(out).length === 0) {
    throw new BadRequestError("provide at least one of: title, muted");
  }
  return out;
}

// POST /content-radar/ideas — generate content angles from the live feed.
// Everything is optional: platform pins the voice profile + output format,
// guidance steers the agent, feed_ids restricts to specific sources, and limit
// caps how many items the agent reads.
export function validateIdeasRequest(rawBody) {
  const body = rawBody ?? {};
  requireObject(body);
  const out = {};

  if (body.platform !== undefined && body.platform !== null) {
    if (typeof body.platform !== "string" || !VOICE_PLATFORMS.includes(body.platform)) {
      throw new BadRequestError(`platform must be one of: ${VOICE_PLATFORMS.join(", ")}`);
    }
    out.platform = body.platform;
  }

  if (body.guidance !== undefined && body.guidance !== null) {
    if (typeof body.guidance !== "string" || body.guidance.trim().length === 0) {
      throw new BadRequestError("guidance must be a non-empty string");
    }
    if (body.guidance.length > GUIDANCE_MAX) {
      throw new BadRequestError(`guidance must be at most ${GUIDANCE_MAX} chars`);
    }
    out.guidance = body.guidance.trim();
  }

  if (body.feed_ids !== undefined && body.feed_ids !== null) {
    if (!Array.isArray(body.feed_ids) || body.feed_ids.some((id) => typeof id !== "string" || id.length === 0)) {
      throw new BadRequestError("feed_ids must be an array of feed id strings");
    }
    out.feedIds = body.feed_ids;
  }

  if (body.limit !== undefined && body.limit !== null) {
    const n = Number(body.limit);
    if (!Number.isInteger(n) || n < 1 || n > IDEAS_ITEM_MAX) {
      throw new BadRequestError(`limit must be an integer between 1 and ${IDEAS_ITEM_MAX}`);
    }
    out.limit = n;
  }

  return out;
}

// Normalizes a topic list (interests / avoid): trims, drops empties, dedupes
// case-insensitively, and enforces per-topic and list-size bounds.
function validateTopicList(value, label) {
  if (!Array.isArray(value)) {
    throw new BadRequestError(`${label} must be an array of strings`);
  }
  const seen = new Set();
  const out = [];
  for (const raw of value) {
    if (typeof raw !== "string") {
      throw new BadRequestError(`${label} must be an array of strings`);
    }
    const t = raw.trim();
    if (t.length === 0) continue;
    if (t.length > TOPIC_MAX) {
      throw new BadRequestError(`each ${label} entry must be at most ${TOPIC_MAX} chars`);
    }
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  if (out.length > TOPIC_LIST_MAX) {
    throw new BadRequestError(`${label} must have at most ${TOPIC_LIST_MAX} entries`);
  }
  return out;
}

// PUT /content-radar/preferences — the creator's stated intent for the radar.
// Every field is optional and independently clearable; only provided keys are
// written (a partial PUT patches). Topic lists clear with `[]`; the scalar
// fields clear with `null`.
export function validateRadarPrefs(body) {
  requireObject(body);
  const out = {};

  if (body.interests !== undefined) {
    out.interests = validateTopicList(body.interests, "interests");
  }
  if (body.avoid !== undefined) {
    out.avoid = validateTopicList(body.avoid, "avoid");
  }

  if (body.default_platform !== undefined) {
    if (body.default_platform === null || body.default_platform === "") {
      out.defaultPlatform = null;
    } else if (typeof body.default_platform !== "string" || !VOICE_PLATFORMS.includes(body.default_platform)) {
      throw new BadRequestError(`default_platform must be null or one of: ${VOICE_PLATFORMS.join(", ")}`);
    } else {
      out.defaultPlatform = body.default_platform;
    }
  }

  if (body.default_guidance !== undefined) {
    if (body.default_guidance === null || (typeof body.default_guidance === "string" && body.default_guidance.trim().length === 0)) {
      out.defaultGuidance = null;
    } else if (typeof body.default_guidance !== "string" || body.default_guidance.length > GUIDANCE_MAX) {
      throw new BadRequestError(`default_guidance must be a string of at most ${GUIDANCE_MAX} chars, or null`);
    } else {
      out.defaultGuidance = body.default_guidance.trim();
    }
  }

  if (body.audience !== undefined) {
    if (body.audience === null || (typeof body.audience === "string" && body.audience.trim().length === 0)) {
      out.audience = null;
    } else if (typeof body.audience !== "string" || body.audience.length > AUDIENCE_MAX) {
      throw new BadRequestError(`audience must be a string of at most ${AUDIENCE_MAX} chars, or null`);
    } else {
      out.audience = body.audience.trim();
    }
  }

  if (Object.keys(out).length === 0) {
    throw new BadRequestError("provide at least one preference to update");
  }
  return out;
}

// The radar preferences singleton (defaults to empty lists / nulls when unset).
export function formatRadarPrefs(row) {
  return {
    interests: Array.isArray(row?.interests) ? row.interests : [],
    avoid: Array.isArray(row?.avoid) ? row.avoid : [],
    default_platform: row?.defaultPlatform ?? null,
    default_guidance: row?.defaultGuidance ?? null,
    audience: row?.audience ?? null,
    updated_at: row?.updatedAt ?? null,
  };
}

// A stored feed source, including best-effort health (lastStatus / lastError /
// lastFetchedAt) so the UI can flag broken sources.
export function formatFeedSource(row) {
  return {
    feed_id: row.feedId,
    url: row.url,
    title: row.title ?? null,
    muted: row.muted === true,
    last_fetched_at: row.lastFetchedAt ?? null,
    last_status: row.lastStatus ?? null,
    last_item_count: typeof row.lastItemCount === "number" ? row.lastItemCount : null,
    last_error: row.lastError ?? null,
    created_at: row.createdAt ?? null,
    updated_at: row.updatedAt ?? null,
  };
}

// One aggregated feed item (live, not persisted).
export function formatFeedItem(item) {
  return {
    title: item.title ?? null,
    link: item.link ?? null,
    summary: item.summary ?? null,
    author: item.author ?? null,
    published_at: item.publishedAt ?? null,
    feed_id: item.feedId ?? null,
    feed_title: item.feedTitle ?? null,
    source_url: item.sourceUrl ?? null,
  };
}

// Per-source fetch outcome from an aggregation, so a client rendering the feed
// can show which sources contributed and which failed.
export function formatFeedResult(result) {
  return {
    feed_id: result.feedId,
    url: result.url,
    ok: result.ok === true,
    item_count: result.itemCount ?? 0,
    feed_title: result.feedTitle ?? null,
    error: result.error ?? null,
  };
}

// The content-angles agent output (suggestContentAngles). Kept flat and
// snake_case so the UI can render themes + angles directly.
export function formatContentIdeas(result) {
  return {
    summary: result.summary ?? null,
    themes: (result.themes ?? []).map((t) => ({
      theme: t.theme,
      momentum: t.momentum ?? null,
      why_it_fits: t.why_it_fits ?? null,
    })),
    angles: (result.angles ?? []).map((a) => ({
      title: a.title,
      angle: a.angle,
      format: a.format ?? null,
      rationale: a.rationale ?? null,
      on_voice_note: a.on_voice_note ?? null,
      sources: Array.isArray(a.sources) ? a.sources : [],
    })),
  };
}
