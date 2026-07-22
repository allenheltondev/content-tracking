import { BadRequestError } from "../services/errors.mjs";

// Shared identifier/date patterns used across validation modules and
// routes. Keep new shared regexes here instead of redefining per file.
// (campaign-reports.mjs keeps its own 80-char report-id variant on
// purpose — different contract.)

export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const CAMPAIGN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function requireUlid(value, field) {
  if (!value || !ULID_RE.test(value)) {
    throw new BadRequestError(`${field} must be a ULID`);
  }
  return value;
}

export function requireCampaignId(value) {
  if (typeof value !== "string" || !CAMPAIGN_ID_RE.test(value)) {
    throw new BadRequestError("campaign_id must be 1-64 characters of letters, digits, underscores, or hyphens");
  }
  return value;
}
