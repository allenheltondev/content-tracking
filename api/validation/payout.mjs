import { BadRequestError } from "../services/errors.mjs";
import { ISO_DATE_RE } from "./common.mjs";

// Same throw-on-fail pattern as validation/vendor.mjs.

const CURRENCY_RE = /^[A-Z]{3}$/;
const INVOICE_REF_MAX = 200;

export const AGGREGATION_CURRENCY = "USD";

export function validatePayoutPayload(payout, { partial }) {
  if (payout === null || payout === undefined) {
    throw new BadRequestError("payout must be an object");
  }
  if (typeof payout !== "object" || Array.isArray(payout)) {
    throw new BadRequestError("payout must be an object");
  }

  const out = {};
  const { amount, currency, paid, paid_at, invoice_ref } = payout;

  if (amount !== undefined) {
    if (amount === null) {
      throw new BadRequestError("payout.amount cannot be cleared; delete the payout instead");
    }
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
      throw new BadRequestError("payout.amount must be a non-negative finite number");
    }
    out.amount = amount;
  } else if (!partial) {
    throw new BadRequestError("payout.amount is required");
  }

  if (currency !== undefined) {
    if (currency === null) {
      throw new BadRequestError("payout.currency cannot be cleared");
    }
    if (typeof currency !== "string" || !CURRENCY_RE.test(currency)) {
      throw new BadRequestError("payout.currency must be an ISO 4217 code (e.g. USD)");
    }
    out.currency = currency;
  } else if (!partial) {
    out.currency = AGGREGATION_CURRENCY;
  }

  if (paid !== undefined) {
    if (paid === null) {
      throw new BadRequestError("payout.paid cannot be cleared");
    }
    if (typeof paid !== "boolean") {
      throw new BadRequestError("payout.paid must be a boolean");
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
        throw new BadRequestError("payout.paid_at must be YYYY-MM-DD");
      }
      out.paid_at = paid_at;
    }
  }

  if (invoice_ref !== undefined) {
    if (invoice_ref === null) {
      out.invoice_ref = null;
    } else {
      if (typeof invoice_ref !== "string" || invoice_ref.length > INVOICE_REF_MAX) {
        throw new BadRequestError(`payout.invoice_ref must be a string up to ${INVOICE_REF_MAX} chars`);
      }
      out.invoice_ref = invoice_ref;
    }
  }

  return out;
}

// Mutates `payout` so that toggling `paid` carries a `paid_at` with it:
// paid=true with no paid_at defaults to today (UTC); paid=false with no
// paid_at clears the date. Used by both PATCH /campaigns and PATCH
// /campaigns/{id}/payout so revenue tracking sees a received date the
// moment a campaign is marked paid.
export function applyPaidAtDefault(payout) {
  if (!payout) return payout;
  if (payout.paid === true && payout.paid_at === undefined) {
    payout.paid_at = new Date().toISOString().slice(0, 10);
  } else if (payout.paid === false && payout.paid_at === undefined) {
    payout.paid_at = null;
  }
  return payout;
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
