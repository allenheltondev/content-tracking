import { BadRequestError } from "../services/errors.mjs";
import { VENDOR_ID_RE } from "./vendor.mjs";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_STATUSES = new Set(["draft", "active", "completed"]);
const NAME_MAX = 200;
const SPONSOR_MAX = 200;

export function validateCampaignCreate(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequestError("request body must be a JSON object");
  }

  const { name, sponsor, vendor_id, startDate, endDate, status, targetMetrics } = body;

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

  return out;
}
