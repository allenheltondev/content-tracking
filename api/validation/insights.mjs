import { BadRequestError } from "../services/errors.mjs";
import { ISO_DATE_RE } from "./common.mjs";

// Query-param validation for GET /insights. Optional startDate/endDate
// (both-or-neither); defaults to the last 90 days. Returns a normalized
// { startDate, endDate } the domain consumes.

const DEFAULT_DAYS = 90;
const MAX_DAYS = 730;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function isValidIsoDate(value) {
  if (!ISO_DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && value === d.toISOString().slice(0, 10);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function parseInsightsQuery(params = {}) {
  const { startDate, endDate } = params;

  // Neither supplied: default to the trailing DEFAULT_DAYS window.
  if (startDate === undefined && endDate === undefined) {
    const end = todayIso();
    return { startDate: addDays(end, -(DEFAULT_DAYS - 1)), endDate: end };
  }

  if (startDate === undefined || endDate === undefined) {
    throw new BadRequestError("Provide both startDate and endDate, or neither");
  }

  if (!isValidIsoDate(startDate) || !isValidIsoDate(endDate)) {
    throw new BadRequestError("startDate and endDate must be valid ISO dates (YYYY-MM-DD)");
  }
  if (startDate > endDate) {
    throw new BadRequestError("startDate must be on or before endDate");
  }

  const span =
    Math.round(
      (new Date(`${endDate}T00:00:00Z`).getTime() -
        new Date(`${startDate}T00:00:00Z`).getTime()) /
        MS_PER_DAY,
    ) + 1;
  if (span > MAX_DAYS) {
    throw new BadRequestError(`date range must be at most ${MAX_DAYS} days`);
  }

  return { startDate, endDate };
}
