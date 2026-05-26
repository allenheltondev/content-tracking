import { BadRequestError } from "../services/errors.mjs";
import { jsonResponse } from "../services/http-handler.mjs";
import { queryCampaignsByDateRange } from "../domain/campaign.mjs";
import { AGGREGATION_CURRENCY } from "../validation/payout.mjs";
import { VENDOR_ID_RE } from "../validation/vendor.mjs";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_GROUPINGS = new Set(["year", "month", "vendor"]);

export function registerRevenueRoutes(app) {
  // GET /revenue
  //
  // Aggregation pulls Campaigns with createdAt in the window from GSI1
  // (gsi1pk=CAMPAIGNS, gsi1sk between {start}#... and {end}#...). Then
  // the vendor filter + paid/booked split + grouping happen in memory.
  // No Scan.
  app.get("/revenue", async ({ event }) => {
    const { startDate, endDate, vendorId, grouping, paidOnly } =
      parseQueryParams(event.queryStringParameters ?? {});

    const campaigns = await queryCampaignsByDateRange({ startDate, endDate });

    const skipped = [];
    const matching = [];

    for (const c of campaigns) {
      if (!c.payout || c.payout.amount === undefined || c.payout.amount === null) continue;
      if (vendorId && c.vendorId !== vendorId) continue;
      if (c.payout.currency !== AGGREGATION_CURRENCY) {
        skipped.push({
          campaign_id: c.campaignId,
          currency: c.payout.currency,
          amount: c.payout.amount,
          reason: `currency ${c.payout.currency} not aggregated; only ${AGGREGATION_CURRENCY} is supported`,
        });
        continue;
      }

      const bookedDate = (c.createdAt || "").slice(0, 10);
      const receivedDate = c.payout.paid ? (c.payout.paid_at || "").slice(0, 10) : null;

      const bookedInWindow = isInWindow(bookedDate, startDate, endDate);
      const receivedInWindow = receivedDate && isInWindow(receivedDate, startDate, endDate);

      if (!bookedInWindow && !receivedInWindow) continue;
      if (paidOnly && !receivedInWindow) continue;

      matching.push({
        campaignId: c.campaignId,
        vendorId: c.vendorId ?? null,
        amount: c.payout.amount,
        bookedDate,
        receivedDate,
        bookedInWindow,
        receivedInWindow,
      });
    }

    return jsonResponse(200, {
      currency: AGGREGATION_CURRENCY,
      range: { startDate, endDate },
      total: aggregate(matching),
      booked: aggregate(matching.filter((m) => m.bookedInWindow)),
      received: aggregate(matching.filter((m) => m.receivedInWindow)),
      groups: buildGroups(matching, grouping),
      skipped,
    });
  });
}

function parseQueryParams(params) {
  const out = {};

  if (params.startDate !== undefined || params.endDate !== undefined) {
    if (params.year !== undefined) {
      throw new BadRequestError("use either year or startDate/endDate, not both");
    }
    if (params.startDate !== undefined && !ISO_DATE_RE.test(params.startDate)) {
      throw new BadRequestError("startDate must be YYYY-MM-DD");
    }
    if (params.endDate !== undefined && !ISO_DATE_RE.test(params.endDate)) {
      throw new BadRequestError("endDate must be YYYY-MM-DD");
    }
    out.startDate = params.startDate || `${new Date().getUTCFullYear()}-01-01`;
    out.endDate = params.endDate || `${new Date().getUTCFullYear()}-12-31`;
  } else {
    const year = params.year !== undefined ? Number(params.year) : new Date().getUTCFullYear();
    if (!Number.isInteger(year) || year < 1900 || year > 2999) {
      throw new BadRequestError("year must be an integer between 1900 and 2999");
    }
    out.startDate = `${year}-01-01`;
    out.endDate = `${year}-12-31`;
  }

  if (params.vendorId !== undefined) {
    if (!VENDOR_ID_RE.test(params.vendorId)) {
      throw new BadRequestError(
        "vendorId must be 1-80 characters of letters, digits, underscores, or hyphens",
      );
    }
    out.vendorId = params.vendorId;
  } else {
    out.vendorId = null;
  }

  if (params.grouping !== undefined) {
    if (!VALID_GROUPINGS.has(params.grouping)) {
      throw new BadRequestError(`grouping must be one of ${[...VALID_GROUPINGS].join(", ")}`);
    }
    out.grouping = params.grouping;
  } else {
    out.grouping = "month";
  }

  if (params.paidOnly !== undefined) {
    if (params.paidOnly !== "true" && params.paidOnly !== "false") {
      throw new BadRequestError("paidOnly must be true or false");
    }
    out.paidOnly = params.paidOnly === "true";
  } else {
    out.paidOnly = false;
  }

  return out;
}

function isInWindow(dateStr, start, end) {
  if (!dateStr) return false;
  if (start && dateStr < start) return false;
  if (end && dateStr > end) return false;
  return true;
}

function aggregate(rows) {
  return {
    amount: rows.reduce((acc, r) => acc + r.amount, 0),
    campaignCount: rows.length,
  };
}

function buildGroups(rows, grouping) {
  const buckets = new Map();
  for (const r of rows) {
    let key;
    if (grouping === "year") key = r.bookedDate.slice(0, 4) || "unknown";
    else if (grouping === "month") key = r.bookedDate.slice(0, 7) || "unknown";
    else key = r.vendorId || "unassigned";

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        key,
        amount: 0,
        campaignCount: 0,
        bookedAmount: 0,
        bookedCount: 0,
        receivedAmount: 0,
        receivedCount: 0,
      };
      buckets.set(key, bucket);
    }
    bucket.amount += r.amount;
    bucket.campaignCount += 1;
    if (r.bookedInWindow) {
      bucket.bookedAmount += r.amount;
      bucket.bookedCount += 1;
    }
    if (r.receivedInWindow) {
      bucket.receivedAmount += r.amount;
      bucket.receivedCount += 1;
    }
  }
  return [...buckets.values()].sort((a, b) => a.key.localeCompare(b.key));
}
