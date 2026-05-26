import { validateCampaignCreate } from "../validation/campaign.mjs";
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
