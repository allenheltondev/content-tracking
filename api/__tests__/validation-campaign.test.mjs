import { validateCampaignCreate, validateCampaignUpdate } from "../validation/campaign.mjs";
import { BadRequestError } from "../services/errors.mjs";

describe("validateCampaignCreate", () => {
  test("rejects non-object body", () => {
    expect(() => validateCampaignCreate(null)).toThrow(BadRequestError);
    expect(() => validateCampaignCreate([])).toThrow(BadRequestError);
    expect(() => validateCampaignCreate("hi")).toThrow(BadRequestError);
  });

  test("requires non-empty name", () => {
    expect(() => validateCampaignCreate({})).toThrow(/name is required/);
    expect(() => validateCampaignCreate({ name: "  " })).toThrow();
  });

  test("rejects name longer than 200 chars", () => {
    expect(() => validateCampaignCreate({ name: "x".repeat(201) })).toThrow(/exceeds 200/);
  });

  test("trims name", () => {
    expect(validateCampaignCreate({ name: "  hello  " }).name).toBe("hello");
  });

  test("rejects malformed vendor_id", () => {
    expect(() => validateCampaignCreate({ name: "ok", vendor_id: "has spaces" })).toThrow(/vendor_id/);
  });

  test("rejects unknown status", () => {
    expect(() => validateCampaignCreate({ name: "ok", status: "archived" })).toThrow(/status must be/);
  });

  test("defaults status to active", () => {
    expect(validateCampaignCreate({ name: "ok" }).status).toBe("active");
  });

  test("rejects malformed startDate", () => {
    expect(() => validateCampaignCreate({ name: "ok", startDate: "2026/01/01" })).toThrow(/YYYY-MM-DD/);
  });

  test("rejects targetMetrics not an object", () => {
    expect(() => validateCampaignCreate({ name: "ok", targetMetrics: [1, 2] })).toThrow(/object/);
  });

  test("happy path with all fields", () => {
    const out = validateCampaignCreate({
      name: "Q2 push",
      sponsor: "Acme",
      vendor_id: "01HV0AABBCCDDEEFFGGHHJJKKM",
      startDate: "2026-04-01",
      endDate: "2026-06-30",
      status: "draft",
      targetMetrics: { impressions: 50000 },
    });
    expect(out).toEqual({
      name: "Q2 push",
      sponsor: "Acme",
      vendorId: "01HV0AABBCCDDEEFFGGHHJJKKM",
      startDate: "2026-04-01",
      endDate: "2026-06-30",
      status: "draft",
      targetMetrics: { impressions: 50000 },
    });
  });
});

describe("validateCampaignUpdate", () => {
  test("rejects non-object body", () => {
    expect(() => validateCampaignUpdate(null)).toThrow(BadRequestError);
    expect(() => validateCampaignUpdate([])).toThrow(BadRequestError);
  });

  test("empty body is a valid no-op", () => {
    expect(validateCampaignUpdate({})).toEqual({});
  });

  test("only includes provided fields (partial)", () => {
    expect(validateCampaignUpdate({ startDate: "2026-06-01" })).toEqual({ startDate: "2026-06-01" });
  });

  test("rejects empty name when present", () => {
    expect(() => validateCampaignUpdate({ name: "  " })).toThrow(/non-empty/);
  });

  test("trims name", () => {
    expect(validateCampaignUpdate({ name: "  hi  " }).name).toBe("hi");
  });

  test("rejects bad status and date", () => {
    expect(() => validateCampaignUpdate({ status: "live" })).toThrow(/status/);
    expect(() => validateCampaignUpdate({ startDate: "2026/06/01" })).toThrow(/YYYY-MM-DD/);
  });

  test("normalizes payout to a full object", () => {
    const out = validateCampaignUpdate({ payout: { amount: 1500, currency: "USD", paid: true } });
    expect(out.payout).toEqual({ amount: 1500, currency: "USD", paid: true });
  });

  test("rejects malformed payout", () => {
    expect(() => validateCampaignUpdate({ payout: { amount: -1 } })).toThrow(/amount/);
    expect(() => validateCampaignUpdate({ payout: { amount: 10, currency: "usd" } })).toThrow(/ISO 4217/);
  });

  test("treats empty-string dates as omitted", () => {
    expect(validateCampaignUpdate({ startDate: "", endDate: "" })).toEqual({});
  });
});
