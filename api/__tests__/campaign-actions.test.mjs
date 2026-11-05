import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";

jest.unstable_mockModule("../domain/campaign.mjs", () => ({
  assertCampaignOwned: jest.fn(),
  createCampaign: jest.fn(),
  updateCampaignFields: jest.fn(),
  updateCampaignPayout: jest.fn(),
}));
jest.unstable_mockModule("../domain/vendor.mjs", () => ({ assertVendorOwned: jest.fn() }));
jest.unstable_mockModule("../services/activity.mjs", () => ({ trackActivity: jest.fn() }));

const campaignDomain = await import("../domain/campaign.mjs");
const { assertVendorOwned } = await import("../domain/vendor.mjs");
const { createTenantCampaign, markCampaignPaid, setCampaignStatus } = await import(
  "../services/campaign-actions.mjs"
);

const TENANT = "tenant-1";

beforeEach(() => {
  jest.clearAllMocks();
  campaignDomain.updateCampaignPayout.mockImplementation(async (id, fields) => ({ campaignId: id, fields }));
});

describe("createTenantCampaign", () => {
  test("stamps the tenant and skips the vendor check without a vendor", async () => {
    campaignDomain.createCampaign.mockResolvedValue({ campaignId: "C1" });
    await createTenantCampaign(TENANT, { name: "Solo", status: "active" });
    expect(assertVendorOwned).not.toHaveBeenCalled();
    expect(campaignDomain.createCampaign).toHaveBeenCalledWith({ name: "Solo", status: "active", tenantId: TENANT });
  });
});

describe("setCampaignStatus", () => {
  test("checks ownership before writing", async () => {
    await setCampaignStatus(TENANT, "C1", "monitoring");
    expect(campaignDomain.assertCampaignOwned).toHaveBeenCalledWith("C1", TENANT);
    expect(campaignDomain.updateCampaignFields).toHaveBeenCalledWith("C1", { status: "monitoring" });
  });
});

describe("markCampaignPaid", () => {
  test("keeps an existing currency when only the amount is supplied", async () => {
    campaignDomain.assertCampaignOwned.mockResolvedValue({ payout: { amount: 100, currency: "EUR" } });
    await markCampaignPaid(TENANT, "C1", { amount: 120, paidAt: "2026-11-01" });
    expect(campaignDomain.updateCampaignPayout).toHaveBeenCalledWith("C1", {
      paid: true,
      paid_at: "2026-11-01",
      amount: 120,
    });
  });

  test("rejects a malformed paid_at before reading the campaign", async () => {
    await expect(markCampaignPaid(TENANT, "C1", { paidAt: "Nov 1" })).rejects.toThrow(/YYYY-MM-DD/);
    expect(campaignDomain.assertCampaignOwned).not.toHaveBeenCalled();
  });
});
