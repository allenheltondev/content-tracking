import { DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { respond } from "./utils/response.mjs";
import { AGGREGATION_CURRENCY } from "./utils/payout.mjs";

const ddb = new DynamoDBClient();

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_GROUPINGS = new Set(["year", "month", "vendor"]);

// GET /revenue
//
// Personal-scale aggregation: Scan all Campaign records, filter and group in
// memory. The campaign cardinality this stack targets (low hundreds at most)
// keeps the Scan within RCU budget and well under the Lambda timeout. Swap
// to a GSI on `entity` if that ever changes.
//
// Booking vs receipt distinction is intentional. `booked` counts every
// campaign whose payout falls inside the window regardless of paid status.
// `received` only counts payouts marked paid AND with a paid_at inside the
// window. The dashboard surfaces both side-by-side.
export const handler = async (event) => {
  const params = event.queryStringParameters || {};
  const parseResult = parseQueryParams(params);
  if (!parseResult.ok) {
    return respond(400, parseResult.message);
  }
  const { startDate, endDate, vendorId, grouping, paidOnly } = parseResult.value;

  const campaigns = await scanCampaigns();

  const skipped = [];
  const matching = [];

  for (const c of campaigns) {
    if (!c.payout || c.payout.amount === undefined || c.payout.amount === null) {
      continue;
    }
    if (vendorId && c.vendorId !== vendorId) {
      continue;
    }
    if (c.payout.currency !== AGGREGATION_CURRENCY) {
      skipped.push({
        campaign_id: c.campaignId,
        currency: c.payout.currency,
        amount: c.payout.amount,
        reason: `currency ${c.payout.currency} not aggregated; only ${AGGREGATION_CURRENCY} is supported`,
      });
      continue;
    }

    // Use paid_at for received-bucket dating when present, otherwise fall
    // back to createdAt for the booked-bucket. This is what makes the
    // booked/received split possible from a single scan.
    const bookedDate = (c.createdAt || "").slice(0, 10);
    const receivedDate = c.payout.paid ? (c.payout.paid_at || "").slice(0, 10) : null;

    const bookedInWindow = isInWindow(bookedDate, startDate, endDate);
    const receivedInWindow = receivedDate && isInWindow(receivedDate, startDate, endDate);

    if (!bookedInWindow && !receivedInWindow) {
      continue;
    }
    if (paidOnly && !receivedInWindow) {
      continue;
    }

    matching.push({
      campaignId: c.campaignId,
      vendorId: c.vendorId ?? null,
      amount: c.payout.amount,
      paid: c.payout.paid === true,
      bookedDate,
      receivedDate,
      bookedInWindow,
      receivedInWindow,
    });
  }

  const total = aggregate(matching, "any");
  const booked = aggregate(matching.filter((m) => m.bookedInWindow), "any");
  const received = aggregate(matching.filter((m) => m.receivedInWindow), "any");
  const groups = buildGroups(matching, grouping);

  return respond(200, {
    currency: AGGREGATION_CURRENCY,
    range: { startDate, endDate },
    total,
    booked,
    received,
    groups,
    skipped,
  });
};

async function scanCampaigns() {
  const items = [];
  let exclusiveStartKey;
  do {
    const result = await ddb.send(new ScanCommand({
      TableName: process.env.TABLE_NAME,
      FilterExpression: "#entity = :v AND #sk = :metadata",
      ExpressionAttributeNames: { "#entity": "entity", "#sk": "sk" },
      ExpressionAttributeValues: marshall({ ":v": "Campaign", ":metadata": "METADATA" }),
      ExclusiveStartKey: exclusiveStartKey,
    }));
    for (const item of result.Items || []) {
      items.push(unmarshall(item));
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items;
}

function parseQueryParams(params) {
  const out = {};

  // Date window. Defaults: current calendar year. Explicit startDate /
  // endDate take precedence; otherwise year=YYYY narrows to Jan-Dec.
  if (params.startDate !== undefined || params.endDate !== undefined) {
    if (params.year !== undefined) {
      return { ok: false, message: "use either year or startDate/endDate, not both" };
    }
    if (params.startDate !== undefined && !ISO_DATE_RE.test(params.startDate)) {
      return { ok: false, message: "startDate must be YYYY-MM-DD" };
    }
    if (params.endDate !== undefined && !ISO_DATE_RE.test(params.endDate)) {
      return { ok: false, message: "endDate must be YYYY-MM-DD" };
    }
    out.startDate = params.startDate || null;
    out.endDate = params.endDate || null;
  } else {
    const year = params.year !== undefined ? Number(params.year) : new Date().getUTCFullYear();
    if (!Number.isInteger(year) || year < 1900 || year > 2999) {
      return { ok: false, message: "year must be an integer between 1900 and 2999" };
    }
    out.startDate = `${year}-01-01`;
    out.endDate = `${year}-12-31`;
  }

  if (params.vendorId !== undefined) {
    if (!ULID_RE.test(params.vendorId)) {
      return { ok: false, message: "vendorId must be a ULID" };
    }
    out.vendorId = params.vendorId;
  } else {
    out.vendorId = null;
  }

  if (params.grouping !== undefined) {
    if (!VALID_GROUPINGS.has(params.grouping)) {
      return { ok: false, message: `grouping must be one of ${[...VALID_GROUPINGS].join(", ")}` };
    }
    out.grouping = params.grouping;
  } else {
    out.grouping = "month";
  }

  if (params.paidOnly !== undefined) {
    if (params.paidOnly !== "true" && params.paidOnly !== "false") {
      return { ok: false, message: "paidOnly must be true or false" };
    }
    out.paidOnly = params.paidOnly === "true";
  } else {
    out.paidOnly = false;
  }

  return { ok: true, value: out };
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
    if (grouping === "year") {
      key = r.bookedDate.slice(0, 4) || "unknown";
    } else if (grouping === "month") {
      key = r.bookedDate.slice(0, 7) || "unknown";
    } else {
      key = r.vendorId || "unassigned";
    }

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
