import { BadRequestError } from "../services/errors.mjs";

// Content posts are long-form pieces published on a content platform
// (Medium articles, dev.to posts) — the content-bucket counterpart to
// social posts. The Chrome extension captures their engagement off each
// platform's own analytics traffic and writes it back via
// PUT .../content-posts/{id}/analytics. Kept separate from social posts
// so sponsor reports can report on the two buckets independently.

export const VALID_CONTENT_PLATFORMS = new Set(["medium", "devto"]);

const URL_MAX = 2048;
const NOTES_MAX = 1000;
const METRIC_KEY_MAX = 40;
const MAX_METRIC_KEYS = 30;
const METRIC_VALUE_MAX = 1e15;

// Maps a content URL's host to one of the supported platforms. Medium
// covers medium.com and its *.medium.com user/publication subdomains;
// dev.to covers dev.to and any of its subdomains.
export function derivePlatform(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
  if (host === "medium.com" || host.endsWith(".medium.com")) {
    return "medium";
  }
  if (host === "dev.to" || host.endsWith(".dev.to")) {
    return "devto";
  }
  return null;
}

export function validateContentPostCreate(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequestError("request body must be a JSON object");
  }

  const { url, platform, notes } = body;

  if (typeof url !== "string" || url.length === 0) {
    throw new BadRequestError("url is required");
  }
  if (!/^https?:\/\//i.test(url)) {
    throw new BadRequestError("url must be http or https");
  }
  if (url.length > URL_MAX) {
    throw new BadRequestError(`url exceeds ${URL_MAX} chars`);
  }

  let resolvedPlatform;
  if (platform !== undefined && platform !== null) {
    if (!VALID_CONTENT_PLATFORMS.has(platform)) {
      throw new BadRequestError(`platform must be one of ${[...VALID_CONTENT_PLATFORMS].join(", ")}`);
    }
    resolvedPlatform = platform;
  } else {
    resolvedPlatform = derivePlatform(url);
    if (!resolvedPlatform) {
      throw new BadRequestError(
        `could not infer platform from url; pass platform as one of ${[...VALID_CONTENT_PLATFORMS].join(", ")}`,
      );
    }
  }

  const out = { url, platform: resolvedPlatform };

  if (notes !== undefined && notes !== null) {
    if (typeof notes !== "string" || notes.length > NOTES_MAX) {
      throw new BadRequestError(`notes must be a string up to ${NOTES_MAX} chars`);
    }
    out.notes = notes;
  }

  return out;
}

// Same metric-map shape as the social-post validator. Kept duplicated
// rather than extracted because the two buckets carry different metric
// vocabularies (views/reads/claps vs likes/reposts/etc.) and a future
// schema tightening on one should not silently propagate to the other.
export function validateAnalyticsUpdate(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequestError("request body must be a JSON object");
  }

  const { metrics, capturedAt } = body;

  if (typeof metrics !== "object" || metrics === null || Array.isArray(metrics)) {
    throw new BadRequestError("metrics must be an object of metric name to count");
  }
  const entries = Object.entries(metrics);
  if (entries.length === 0) {
    throw new BadRequestError("metrics must contain at least one metric");
  }
  if (entries.length > MAX_METRIC_KEYS) {
    throw new BadRequestError(`metrics may contain at most ${MAX_METRIC_KEYS} keys`);
  }
  const cleanMetrics = {};
  for (const [key, value] of entries) {
    if (typeof key !== "string" || key.length === 0 || key.length > METRIC_KEY_MAX) {
      throw new BadRequestError(`metric names must be 1-${METRIC_KEY_MAX} chars`);
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > METRIC_VALUE_MAX) {
      throw new BadRequestError(`metric "${key}" must be a non-negative finite number`);
    }
    cleanMetrics[key] = value;
  }

  const out = { metrics: cleanMetrics };

  if (capturedAt !== undefined && capturedAt !== null) {
    if (typeof capturedAt !== "string" || isNaN(Date.parse(capturedAt))) {
      throw new BadRequestError("capturedAt must be an ISO date-time string");
    }
    out.capturedAt = capturedAt;
  }

  return out;
}

export const formatContentPost = (row) => ({
  campaign_id: row.campaignId,
  post_id: row.postId,
  platform: row.platform,
  url: row.url,
  notes: row.notes ?? null,
  analytics: row.analytics ?? null,
  last_fetched: row.lastFetched ?? null,
  captured_at: row.capturedAt ?? null,
  created_at: row.createdAt,
  updated_at: row.updatedAt ?? null,
});
