import { queryCampaignsByDateRange } from "./campaign.mjs";
import { getVendor } from "./vendor.mjs";
import { AGGREGATION_CURRENCY } from "../validation/payout.mjs";

// Builds a frozen, vendor-facing snapshot of revenue for a single vendor
// over [startDate, endDate]. The booked/received/in-window + USD-only
// filtering and month-grouping must agree with GET /revenue
// (routes/revenue.mjs) — keep the logic in sync.
//
// Stays Scan-free: reads come from getVendor (a GetItem) and
// queryCampaignsByDateRange (a GSI1 Query), then everything is aggregated
// in memory.

export async function buildVendorReportSnapshot({ vendorId, startDate, endDate }) {
  // Throws NotFoundError when the vendor doesn't exist — let it propagate
  // so the report agrees with every other vendor-scoped endpoint.
  const vendor = await getVendor(vendorId);

  const campaigns = await queryCampaignsByDateRange({ startDate, endDate });

  const skipped = [];
  const matching = [];

  for (const c of campaigns) {
    if (!c.payout || c.payout.amount === undefined || c.payout.amount === null) continue;
    if (c.vendorId !== vendorId) continue;
    if (c.payout.currency !== AGGREGATION_CURRENCY) {
      skipped.push({
        campaignId: c.campaignId,
        currency: c.payout.currency,
        amount: c.payout.amount,
        reason: `currency ${c.payout.currency} not aggregated; only ${AGGREGATION_CURRENCY} is supported`,
      });
      continue;
    }

    const bookedDate = (c.createdAt || "").slice(0, 10);
    const receivedDate = c.payout.paid ? (c.payout.paid_at || "").slice(0, 10) : null;

    const bookedInWindow = isInWindow(bookedDate, startDate, endDate);
    const receivedInWindow = Boolean(receivedDate) && isInWindow(receivedDate, startDate, endDate);

    if (!bookedInWindow && !receivedInWindow) continue;

    matching.push({
      campaignId: c.campaignId,
      name: c.name ?? null,
      amount: c.payout.amount,
      currency: c.payout.currency,
      bookedDate,
      bookedInWindow,
      receivedInWindow,
      paid: c.payout.paid === true,
      paidAt: c.payout.paid_at ?? null,
    });
  }

  const summary = buildSummary(matching);
  const monthly = buildMonthly(matching);
  const campaignsOut = matching.map((m) => ({
    campaignId: m.campaignId,
    name: m.name,
    bookedDate: m.bookedDate,
    amount: m.amount,
    currency: m.currency,
    status: m.paid ? "paid" : "booked",
    paidAt: m.paidAt,
  }));

  const now = new Date();

  return {
    schemaVersion: 1,
    report: {
      id: null,
      generatedAt: now.toISOString(),
      dataAsOf: now.toISOString().slice(0, 10),
      period: {
        startDate,
        endDate,
        label: periodLabel(startDate, endDate),
      },
      currency: AGGREGATION_CURRENCY,
    },
    vendor: {
      id: vendor.vendorId,
      name: vendor.name,
      website: vendor.website ?? null,
      contactName: vendor.contact_name ?? null,
      paymentTerms: vendor.payment_terms ?? null,
    },
    summary,
    monthly,
    campaigns: campaignsOut,
    skipped,
  };
}

function isInWindow(dateStr, start, end) {
  if (!dateStr) return false;
  if (start && dateStr < start) return false;
  if (end && dateStr > end) return false;
  return true;
}

function buildSummary(rows) {
  let totalBookedAmount = 0;
  let totalReceivedAmount = 0;
  let paidCount = 0;
  let unpaidCount = 0;

  for (const r of rows) {
    if (r.bookedInWindow) totalBookedAmount += r.amount;
    if (r.receivedInWindow) totalReceivedAmount += r.amount;
    if (r.paid) paidCount += 1;
    else unpaidCount += 1;
  }

  return {
    totalBookedAmount,
    totalReceivedAmount,
    outstandingAmount: Math.max(0, totalBookedAmount - totalReceivedAmount),
    campaignCount: rows.length,
    paidCount,
    unpaidCount,
  };
}

function buildMonthly(rows) {
  const buckets = new Map();
  for (const r of rows) {
    const month = r.bookedDate.slice(0, 7);
    let bucket = buckets.get(month);
    if (!bucket) {
      bucket = { month, bookedAmount: 0, receivedAmount: 0, campaignCount: 0 };
      buckets.set(month, bucket);
    }
    bucket.campaignCount += 1;
    if (r.bookedInWindow) bucket.bookedAmount += r.amount;
    if (r.receivedInWindow) bucket.receivedAmount += r.amount;
  }
  return [...buckets.values()].sort((a, b) => a.month.localeCompare(b.month));
}

// "YYYY" when the range spans exactly one full calendar year
// (YYYY-01-01 .. YYYY-12-31); otherwise "startDate – endDate".
function periodLabel(startDate, endDate) {
  if (
    typeof startDate === "string" &&
    typeof endDate === "string" &&
    startDate.length === 10 &&
    endDate.length === 10 &&
    startDate.slice(0, 4) === endDate.slice(0, 4) &&
    startDate.slice(4) === "-01-01" &&
    endDate.slice(4) === "-12-31"
  ) {
    return startDate.slice(0, 4);
  }
  return `${startDate} – ${endDate}`;
}
