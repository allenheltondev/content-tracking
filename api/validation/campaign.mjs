import { BadRequestError } from "../services/errors.mjs";
import { extractYoutubeVideoId } from "../services/youtube.mjs";
import { formatPayout, validatePayoutPayload } from "./payout.mjs";
import { VENDOR_ID_RE } from "./vendor.mjs";
import { ISO_DATE_RE } from "./common.mjs";

// Shapes a stored campaign row into the snake_case API response. Lives here
// (rather than the route module) so both the campaign routes and the content
// routes — which expose a campaign as a sponsorship hanging off a content
// piece — can format campaigns without dragging in the route module's heavy
// Bedrock/S3 imports. `content_id` is the content piece it hangs off (1:1).
export function formatCampaign(row) {
  return {
    campaign_id: row.campaignId,
    name: row.name,
    sponsor: row.sponsor ?? null,
    vendor_id: row.vendorId ?? null,
    content_id: row.contentId ?? null,
    startDate: row.startDate ?? null,
    endDate: row.endDate ?? null,
    status: row.status,
    targetMetrics: row.targetMetrics ?? null,
    payout: formatPayout(row.payout),
    deliverable_type: row.deliverableType ?? "blog",
    blog_url: row.blogUrl ?? null,
    youtube_url: row.youtubeUrl ?? null,
    link_tracking_id: row.linkTrackingId ?? null,
    created_at: row.createdAt,
  };
}

const VALID_STATUSES = new Set(["draft", "active", "monitoring", "completed"]);
// A campaign's main deliverable is either a published blog post (tracked via
// GA4 + Core Web Vitals off blog_url) or a YouTube video (tracked via the
// YouTube Data API off youtube_url). The two are mutually exclusive.
const VALID_DELIVERABLE_TYPES = new Set(["blog", "youtube"]);
const NAME_MAX = 200;
const SPONSOR_MAX = 200;
const BLOG_URL_MAX = 2048;
const YOUTUBE_URL_MAX = 2048;
const LINK_TRACKING_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

// The campaign's published blog post. Used as the GA4 page-path filter and
// the Core Web Vitals lookup URL. Must be an absolute http(s) URL.
function validateBlogUrl(value) {
  if (typeof value !== "string" || value.length > BLOG_URL_MAX) {
    throw new BadRequestError(`blog_url must be a string up to ${BLOG_URL_MAX} chars`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new BadRequestError("blog_url must be a valid absolute URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BadRequestError("blog_url must be an http(s) URL");
  }
  return value;
}

// The campaign's published YouTube video. Used as the YouTube Data API
// lookup on GET /campaigns/{campaignId}/web-analytics. Must be a URL we can
// pull a video id out of (watch, youtu.be, shorts, embed, ...).
function validateYoutubeUrl(value) {
  if (typeof value !== "string" || value.length > YOUTUBE_URL_MAX) {
    throw new BadRequestError(`youtube_url must be a string up to ${YOUTUBE_URL_MAX} chars`);
  }
  if (!extractYoutubeVideoId(value)) {
    throw new BadRequestError("youtube_url must be a valid YouTube video URL");
  }
  return value;
}

export function validateCampaignCreate(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequestError("request body must be a JSON object");
  }

  const {
    name,
    sponsor,
    vendor_id,
    startDate,
    endDate,
    status,
    targetMetrics,
    deliverable_type,
    blog_url,
    youtube_url,
    link_tracking_id,
  } = body;

  if (typeof name !== "string" || name.trim().length === 0) {
    throw new BadRequestError("name is required");
  }
  if (name.length > NAME_MAX) {
    throw new BadRequestError(`name exceeds ${NAME_MAX} chars`);
  }

  const out = { name: name.trim() };

  if (sponsor !== undefined && sponsor !== null) {
    if (typeof sponsor !== "string" || sponsor.length > SPONSOR_MAX) {
      throw new BadRequestError(`sponsor must be a string up to ${SPONSOR_MAX} chars`);
    }
    out.sponsor = sponsor;
  }

  if (vendor_id !== undefined && vendor_id !== null) {
    if (typeof vendor_id !== "string" || !VENDOR_ID_RE.test(vendor_id)) {
      throw new BadRequestError(
        "vendor_id must be 1-80 characters of letters, digits, underscores, or hyphens",
      );
    }
    out.vendorId = vendor_id;
  }

  if (status !== undefined) {
    if (!VALID_STATUSES.has(status)) {
      throw new BadRequestError(`status must be one of ${[...VALID_STATUSES].join(", ")}`);
    }
    out.status = status;
  } else {
    out.status = "active";
  }

  if (startDate !== undefined && startDate !== null) {
    if (typeof startDate !== "string" || !ISO_DATE_RE.test(startDate)) {
      throw new BadRequestError("startDate must be YYYY-MM-DD");
    }
    out.startDate = startDate;
  }

  if (endDate !== undefined && endDate !== null) {
    if (typeof endDate !== "string" || !ISO_DATE_RE.test(endDate)) {
      throw new BadRequestError("endDate must be YYYY-MM-DD");
    }
    out.endDate = endDate;
  }

  if (targetMetrics !== undefined && targetMetrics !== null) {
    if (typeof targetMetrics !== "object" || Array.isArray(targetMetrics)) {
      throw new BadRequestError("targetMetrics must be an object");
    }
    out.targetMetrics = targetMetrics;
  }

  if (deliverable_type !== undefined && deliverable_type !== null && deliverable_type !== "") {
    if (!VALID_DELIVERABLE_TYPES.has(deliverable_type)) {
      throw new BadRequestError(`deliverable_type must be one of ${[...VALID_DELIVERABLE_TYPES].join(", ")}`);
    }
    out.deliverableType = deliverable_type;
  }

  if (blog_url !== undefined && blog_url !== null && blog_url !== "") {
    out.blogUrl = validateBlogUrl(blog_url);
  }

  if (youtube_url !== undefined && youtube_url !== null && youtube_url !== "") {
    out.youtubeUrl = validateYoutubeUrl(youtube_url);
  }

  if (link_tracking_id !== undefined && link_tracking_id !== null && link_tracking_id !== "") {
    if (typeof link_tracking_id !== "string" || !LINK_TRACKING_ID_RE.test(link_tracking_id)) {
      throw new BadRequestError(
        "link_tracking_id must be 1-128 characters of letters, digits, underscores, or hyphens",
      );
    }
    out.linkTrackingId = link_tracking_id;
  }

  return out;
}

// Validates the fields a user accepts from a brief's suggestions and
// applies to an existing campaign (PATCH /campaigns/{id}). Every field is
// optional — only the ones present are updated. `vendor_id` re-links the
// campaign to a vendor record (the detail-page vendor picker); the domain
// layer keeps the vendor's campaign list in sync. `payout` is normalized
// to a full object and replaces the campaign's payout wholesale.
export function validateCampaignUpdate(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequestError("request body must be a JSON object");
  }

  const {
    name,
    sponsor,
    vendor_id,
    startDate,
    endDate,
    status,
    targetMetrics,
    payout,
    deliverable_type,
    blog_url,
    youtube_url,
    link_tracking_id,
  } = body;
  const out = {};

  if (name !== undefined) {
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new BadRequestError("name must be a non-empty string");
    }
    if (name.length > NAME_MAX) {
      throw new BadRequestError(`name exceeds ${NAME_MAX} chars`);
    }
    out.name = name.trim();
  }

  if (sponsor !== undefined && sponsor !== null) {
    if (typeof sponsor !== "string" || sponsor.length > SPONSOR_MAX) {
      throw new BadRequestError(`sponsor must be a string up to ${SPONSOR_MAX} chars`);
    }
    out.sponsor = sponsor;
  }

  if (vendor_id !== undefined && vendor_id !== null) {
    if (typeof vendor_id !== "string" || !VENDOR_ID_RE.test(vendor_id)) {
      throw new BadRequestError(
        "vendor_id must be 1-80 characters of letters, digits, underscores, or hyphens",
      );
    }
    out.vendorId = vendor_id;
  }

  if (status !== undefined) {
    if (!VALID_STATUSES.has(status)) {
      throw new BadRequestError(`status must be one of ${[...VALID_STATUSES].join(", ")}`);
    }
    out.status = status;
  }

  if (startDate !== undefined && startDate !== null && startDate !== "") {
    if (typeof startDate !== "string" || !ISO_DATE_RE.test(startDate)) {
      throw new BadRequestError("startDate must be YYYY-MM-DD");
    }
    out.startDate = startDate;
  }

  if (endDate !== undefined && endDate !== null && endDate !== "") {
    if (typeof endDate !== "string" || !ISO_DATE_RE.test(endDate)) {
      throw new BadRequestError("endDate must be YYYY-MM-DD");
    }
    out.endDate = endDate;
  }

  if (targetMetrics !== undefined && targetMetrics !== null) {
    if (typeof targetMetrics !== "object" || Array.isArray(targetMetrics)) {
      throw new BadRequestError("targetMetrics must be an object");
    }
    out.targetMetrics = targetMetrics;
  }

  if (payout !== undefined && payout !== null) {
    out.payout = validatePayoutPayload(payout, { partial: false });
  }

  if (deliverable_type !== undefined && deliverable_type !== null && deliverable_type !== "") {
    if (!VALID_DELIVERABLE_TYPES.has(deliverable_type)) {
      throw new BadRequestError(`deliverable_type must be one of ${[...VALID_DELIVERABLE_TYPES].join(", ")}`);
    }
    out.deliverableType = deliverable_type;
  }

  if (blog_url !== undefined && blog_url !== null && blog_url !== "") {
    out.blogUrl = validateBlogUrl(blog_url);
  }

  if (youtube_url !== undefined && youtube_url !== null && youtube_url !== "") {
    out.youtubeUrl = validateYoutubeUrl(youtube_url);
  }

  if (link_tracking_id !== undefined && link_tracking_id !== null && link_tracking_id !== "") {
    if (typeof link_tracking_id !== "string" || !LINK_TRACKING_ID_RE.test(link_tracking_id)) {
      throw new BadRequestError(
        "link_tracking_id must be 1-128 characters of letters, digits, underscores, or hyphens",
      );
    }
    out.linkTrackingId = link_tracking_id;
  }

  return out;
}
