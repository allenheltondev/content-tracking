import { applyPaidAtDefault, validatePayoutPayload, formatPayout } from "../validation/payout.mjs";
import { BadRequestError } from "../services/errors.mjs";

describe("validatePayoutPayload", () => {
  test("rejects non-object body", () => {
    expect(() => validatePayoutPayload(null, { partial: false })).toThrow(BadRequestError);
    expect(() => validatePayoutPayload([], { partial: false })).toThrow();
  });

  describe("full validation (create)", () => {
    const opts = { partial: false };

    test("requires amount", () => {
      expect(() => validatePayoutPayload({}, opts)).toThrow(/amount is required/);
    });

    test("rejects negative amount", () => {
      expect(() => validatePayoutPayload({ amount: -1 }, opts)).toThrow();
    });

    test("defaults currency to USD", () => {
      expect(validatePayoutPayload({ amount: 5000 }, opts).currency).toBe("USD");
    });

    test("rejects malformed currency", () => {
      expect(() => validatePayoutPayload({ amount: 5000, currency: "usd" }, opts)).toThrow();
    });

    test("defaults paid to false", () => {
      expect(validatePayoutPayload({ amount: 5000 }, opts).paid).toBe(false);
    });
  });

  describe("partial update", () => {
    const opts = { partial: true };

    test("allows just paid=true", () => {
      const out = validatePayoutPayload({ paid: true }, opts);
      expect(out).toEqual({ paid: true });
    });

    test("rejects clearing amount", () => {
      expect(() => validatePayoutPayload({ amount: null }, opts)).toThrow(/cannot be cleared/);
    });

    test("allows clearing paid_at and invoice_ref", () => {
      const out = validatePayoutPayload({ paid_at: null, invoice_ref: null }, opts);
      expect(out.paid_at).toBeNull();
      expect(out.invoice_ref).toBeNull();
    });

    test("rejects malformed paid_at", () => {
      expect(() => validatePayoutPayload({ paid_at: "yesterday" }, opts)).toThrow(/YYYY-MM-DD/);
    });
  });
});

describe("applyPaidAtDefault", () => {
  test("paid=true with no paid_at fills today's UTC date", () => {
    const payout = { amount: 5000, currency: "USD", paid: true };
    applyPaidAtDefault(payout);
    expect(payout.paid_at).toBe(new Date().toISOString().slice(0, 10));
  });

  test("paid=false with no paid_at clears to null", () => {
    const payout = { amount: 5000, currency: "USD", paid: false };
    applyPaidAtDefault(payout);
    expect(payout.paid_at).toBeNull();
  });

  test("does not overwrite an explicit paid_at", () => {
    const payout = { paid: true, paid_at: "2026-01-15" };
    applyPaidAtDefault(payout);
    expect(payout.paid_at).toBe("2026-01-15");
  });

  test("explicit null paid_at is preserved", () => {
    const payout = { paid: true, paid_at: null };
    applyPaidAtDefault(payout);
    expect(payout.paid_at).toBeNull();
  });

  test("no-op when payout is missing", () => {
    expect(applyPaidAtDefault(undefined)).toBeUndefined();
    expect(applyPaidAtDefault(null)).toBeNull();
  });
});

describe("formatPayout", () => {
  test("returns null for missing payout", () => {
    expect(formatPayout(null)).toBeNull();
    expect(formatPayout(undefined)).toBeNull();
  });

  test("fills nullable defaults", () => {
    expect(formatPayout({ amount: 5000, currency: "USD" })).toEqual({
      amount: 5000,
      currency: "USD",
      paid: false,
      paid_at: null,
      invoice_ref: null,
    });
  });

  test("preserves all fields", () => {
    expect(formatPayout({
      amount: 7500,
      currency: "USD",
      paid: true,
      paid_at: "2026-04-15",
      invoice_ref: "INV-1",
    })).toEqual({
      amount: 7500,
      currency: "USD",
      paid: true,
      paid_at: "2026-04-15",
      invoice_ref: "INV-1",
    });
  });
});
