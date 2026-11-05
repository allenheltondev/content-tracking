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
  test("checks ownership before writing an allowed move", async () => {
    campaignDomain.assertCampaignOwned.mockResolvedValue({ campaignId: "C1", status: "active" });
    await setCampaignStatus(TENANT, "C1", "monitoring");
    expect(campaignDomain.assertCampaignOwned).toHaveBeenCalledWith("C1", TENANT);
    expect(campaignDomain.updateCampaignFields).toHaveBeenCalledWith(
      "C1", { status: "monitoring" }, { expectStatus: "active" },
    );
  });

  test.each([
    ["draft", "monitoring"],
    ["draft", "completed"],
    ["monitoring", "draft"],
    ["completed", "active"],
  ])("rejects %s -> %s without writing", async (from, to) => {
    campaignDomain.assertCampaignOwned.mockResolvedValue({ campaignId: "C1", status: from });
    await expect(setCampaignStatus(TENANT, "C1", to)).rejects.toThrow(`Cannot move a campaign from ${from} to ${to}`);
    expect(campaignDomain.updateCampaignFields).not.toHaveBeenCalled();
  });

  test.each([
    ["draft", "active"],
    ["active", "draft"],
    ["active", "completed"],
    ["monitoring", "active"],
    ["monitoring", "completed"],
  ])("allows %s -> %s", async (from, to) => {
    campaignDomain.assertCampaignOwned.mockResolvedValue({ campaignId: "C1", status: from });
    await setCampaignStatus(TENANT, "C1", to);
    expect(campaignDomain.updateCampaignFields).toHaveBeenCalledWith("C1", { status: to }, { expectStatus: from });
  });

  test("treats the current status as a no-op", async () => {
    const campaign = { campaignId: "C1", status: "completed" };
    campaignDomain.assertCampaignOwned.mockResolvedValue(campaign);
    await expect(setCampaignStatus(TENANT, "C1", "completed")).resolves.toBe(campaign);
    expect(campaignDomain.updateCampaignFields).not.toHaveBeenCalled();
  });

  test("treats a legacy row with no status as active", async () => {
    campaignDomain.assertCampaignOwned.mockResolvedValue({ campaignId: "C1" });
    await setCampaignStatus(TENANT, "C1", "monitoring");
    // The guard expects "no status attribute", not "active".
    expect(campaignDomain.updateCampaignFields).toHaveBeenCalledWith(
      "C1", { status: "monitoring" }, { expectStatus: undefined },
    );
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
