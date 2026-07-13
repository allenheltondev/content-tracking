import { BadRequestError } from "../services/errors.mjs";

// Validation + formatting for content publishing and analytics: where a piece
// of content was published (publish variants) and its per-platform daily metric
// snapshots (stats). Unlike a campaign's social posts, content can be published
// anywhere, so `platform` is a free-form slug rather than a fixed enum.

const PLATFORM_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/i;
const URL_MAX = 2048;
const NOTES_MAX = 1000;
const METRIC_KEY_MAX = 40;
const MAX_METRIC_KEYS = 30;
const METRIC_VALUE_MAX = 1e15;

export function validatePlatform(value) {
  if (typeof value !== "string" || !PLATFORM_RE.test(value)) {
    throw new BadRequestError("platform must be a 1-40 char slug (letters, digits, ._-)");
  }
  return value.toLowerCase();
}

// Body for POST /content/:id/publish — records that a piece was published to a
// platform. `platform` is required; url/published_at/notes are optional.
export function validatePublishVariant(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequestError("request body must be a JSON object");
  }
  const { platform, url, published_at, notes } = body;
  const out = { platform: validatePlatform(platform) };

  if (url !== undefined && url !== null) {
    if (typeof url !== "string" || url.length > URL_MAX || !/^https?:\/\//i.test(url)) {
      throw new BadRequestError(`url must be an http(s) string up to ${URL_MAX} chars`);
    }
    out.url = url;
  }
  if (published_at !== undefined && published_at !== null) {
    if (typeof published_at !== "string" || isNaN(Date.parse(published_at))) {
      throw new BadRequestError("published_at must be an ISO date-time string");
    }
    out.publishedAt = published_at;
  }
  if (notes !== undefined && notes !== null) {
    if (typeof notes !== "string" || notes.length > NOTES_MAX) {
      throw new BadRequestError(`notes must be a string up to ${NOTES_MAX} chars`);
    }
    out.notes = notes;
  }
  return out;
}

// Body for PUT /content/:id/stats/:platform — a metric snapshot for the day.
// `metrics` is an open map of name -> non-negative number so each platform can
// report whatever it exposes (views, reactions, reads, ...) without a schema
// change. `captured_at` is the client-observed time; the server stamps its own.
export function validateStatsUpdate(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequestError("request body must be a JSON object");
  }
  const { metrics, captured_at } = body;

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
  if (captured_at !== undefined && captured_at !== null) {
    if (typeof captured_at !== "string" || isNaN(Date.parse(captured_at))) {
      throw new BadRequestError("captured_at must be an ISO date-time string");
    }
    out.capturedAt = captured_at;
  }
  return out;
}

export const formatPublishVariant = (row) => ({
  platform: row.platform,
  url: row.url ?? null,
  published_at: row.publishedAt ?? null,
  notes: row.notes ?? null,
  updated_at: row.updatedAt ?? null,
});

export const formatStatsSnapshot = (row) => ({
  platform: row.platform,
  date: row.date,
  metrics: row.metrics ?? {},
  captured_at: row.capturedAt ?? null,
});
