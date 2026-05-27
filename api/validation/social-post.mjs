import { BadRequestError } from "../services/errors.mjs";

// Social posts are the actual published posts on a platform (the tweet,
// the LinkedIn update, the Instagram post) — distinct from the short
// Links this stack mints for click tracking. The Chrome extension reads
// their URLs for active campaigns and writes captured engagement metrics
// back via PUT .../analytics.

export const VALID_PLATFORMS = new Set(["twitter", "linkedin", "instagram"]);

const URL_MAX = 2048;
const NOTES_MAX = 1000;
const METRIC_KEY_MAX = 40;
const MAX_METRIC_KEYS = 30;
const METRIC_VALUE_MAX = 1e15;

// Maps a post URL's host to one of the supported platforms so callers can
// register a post by URL alone. x.com and twitter.com both map to
// "twitter" so historical and current links land on the same adapter.
export function derivePlatform(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
  if (host === "twitter.com" || host === "x.com" || host.endsWith(".twitter.com")) {
    return "twitter";
  }
  if (host === "linkedin.com" || host.endsWith(".linkedin.com")) {
    return "linkedin";
  }
  if (host === "instagram.com" || host.endsWith(".instagram.com")) {
    return "instagram";
  }
  return null;
}

export function validateSocialPostCreate(body) {
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
    if (!VALID_PLATFORMS.has(platform)) {
      throw new BadRequestError(`platform must be one of ${[...VALID_PLATFORMS].join(", ")}`);
    }
    resolvedPlatform = platform;
  } else {
    resolvedPlatform = derivePlatform(url);
    if (!resolvedPlatform) {
      throw new BadRequestError(
        `could not infer platform from url; pass platform as one of ${[...VALID_PLATFORMS].join(", ")}`,
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

// The extension PUTs captured engagement here. `metrics` is an open map of
// metric name -> count so each platform adapter can report whatever it
// extracts (likes, reposts, replies, views, impressions, ...) without a
// schema change. `capturedAt` is the client-observed timestamp; the
// authoritative `lastFetched` is stamped server-side on write.
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

export const formatSocialPost = (row) => ({
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
