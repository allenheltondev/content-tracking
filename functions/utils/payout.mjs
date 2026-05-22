// Shared validation + formatting for the Campaign.payout structure.
//
// Same pattern as functions/utils/vendor.mjs — centralized so create-campaign
// and update-campaign-payout agree on field rules, and so the update path can
// forward explicit nulls to a REMOVE clause rather than silently dropping
// them.

const CURRENCY_RE = /^[A-Z]{3}$/;            // ISO 4217 alphabetic
const INVOICE_REF_MAX = 200;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// First-pass aggregation only sums USD. Non-USD campaigns surface in the
// `skipped` array on /revenue. Multi-currency rollup is a separate decision
// (FX rates, snapshot dates, base currency selection) — out of scope here.
export const AGGREGATION_CURRENCY = "USD";

export function validatePayoutPayload(payout, { partial }) {
  if (payout === null || payout === undefined) {
    // For partial updates, callers can pass `payout: null` at the top level
    // to clear the whole payout. The handler routes for that case directly;
    // we never see it here.
    return { ok: false, message: "payout must be an object" };
  }
  if (typeof payout !== "object" || Array.isArray(payout)) {
    return { ok: false, message: "payout must be an object" };
  }

  const out = {};
  const { amount, currency, paid, paid_at, invoice_ref } = payout;

  if (amount !== undefined) {
    if (amount === null) {
      // amount is required on create. On partial update, nulling it would
      // leave a payout with no amount — disallow.
      return { ok: false, message: "payout.amount cannot be cleared; delete the payout instead" };
    }
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
      return { ok: false, message: "payout.amount must be a non-negative finite number" };
    }
    out.amount = amount;
  } else if (!partial) {
    return { ok: false, message: "payout.amount is required" };
  }

  if (currency !== undefined) {
    if (currency === null) {
      return { ok: false, message: "payout.currency cannot be cleared" };
    }
    if (typeof currency !== "string" || !CURRENCY_RE.test(currency)) {
      return { ok: false, message: "payout.currency must be an ISO 4217 code (e.g. USD)" };
    }
    out.currency = currency;
  } else if (!partial) {
    out.currency = AGGREGATION_CURRENCY; // default on create
  }

  if (paid !== undefined) {
    if (paid === null) {
      return { ok: false, message: "payout.paid cannot be cleared" };
    }
    if (typeof paid !== "boolean") {
      return { ok: false, message: "payout.paid must be a boolean" };
    }
    out.paid = paid;
  } else if (!partial) {
    out.paid = false;
  }

  if (paid_at !== undefined) {
    if (paid_at === null) {
      out.paid_at = null;
    } else {
      if (typeof paid_at !== "string" || !ISO_DATE_RE.test(paid_at)) {
        return { ok: false, message: "payout.paid_at must be YYYY-MM-DD" };
      }
      out.paid_at = paid_at;
    }
  }

  if (invoice_ref !== undefined) {
    if (invoice_ref === null) {
      out.invoice_ref = null;
    } else {
      if (typeof invoice_ref !== "string" || invoice_ref.length > INVOICE_REF_MAX) {
        return { ok: false, message: `payout.invoice_ref must be a string up to ${INVOICE_REF_MAX} chars` };
      }
      out.invoice_ref = invoice_ref;
    }
  }

  return { ok: true, value: out };
}

export function formatPayout(payout) {
  if (!payout) return null;
  return {
    amount: payout.amount,
    currency: payout.currency,
    paid: payout.paid ?? false,
    paid_at: payout.paid_at ?? null,
    invoice_ref: payout.invoice_ref ?? null,
  };
}
