import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";
process.env.ENVIRONMENT = "staging";

// Mock the vendor + campaign domains so this aggregation layer is exercised
// in isolation (no DynamoDB). Matches the unstable_mockModule idiom used by
// the other domain tests.
jest.unstable_mockModule("../domain/vendor.mjs", () => ({
  getVendor: jest.fn(),
}));
jest.unstable_mockModule("../domain/campaign.mjs", () => ({
  queryCampaignsByDateRange: jest.fn(),
}));

const vendorDomain = await import("../domain/vendor.mjs");
const campaignDomain = await import("../domain/campaign.mjs");
const { NotFoundError } = await import("../services/errors.mjs");
const { buildVendorReportSnapshot } = await import("../domain/vendor-report.mjs");

function vendorItem(overrides = {}) {
  return {
    vendorId: "V1",
    name: "Acme",
    website: "https://acme.test",
    contact_name: "Jane Doe",
    contact_email: "jane@acme.test",
    payment_terms: "Net 30",
    notes: "internal note about Acme",
    ...overrides,
  };
}

// createdAt drives the booked date (sliced to YYYY-MM-DD).
function campaign({
  campaignId,
  vendorId = "V1",
  name = "Campaign",
  createdAt,
  amount,
  currency = "USD",
  paid = false,
  paidAt = null,
}) {
  const payout = amount === undefined
    ? undefined
    : { amount, currency, paid, paid_at: paidAt };
  return { campaignId, vendorId, name, createdAt, payout };
}

describe("domain/vendor-report buildVendorReportSnapshot", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    vendorDomain.getVendor.mockReset();
    campaignDomain.queryCampaignsByDateRange.mockReset();
    vendorDomain.getVendor.mockResolvedValue(vendorItem());
  });

  describe("not-found propagation", () => {
    test("propagates NotFoundError from getVendor", async () => {
      vendorDomain.getVendor.mockRejectedValue(new NotFoundError("Vendor", "V1"));
      await expect(
        buildVendorReportSnapshot({ vendorId: "V1", startDate: "2026-01-01", endDate: "2026-12-31" }),
      ).rejects.toThrow(/Vendor V1 not found/);
      // Should fail before querying campaigns.
      expect(campaignDomain.queryCampaignsByDateRange).not.toHaveBeenCalled();
    });
  });

  describe("vendor mapping + PII exclusion", () => {
    test("maps fields and excludes contact_email / notes", async () => {
      campaignDomain.queryCampaignsByDateRange.mockResolvedValue([]);
      const snap = await buildVendorReportSnapshot({
        vendorId: "V1",
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });

      expect(snap.vendor).toEqual({
        id: "V1",
        name: "Acme",
        website: "https://acme.test",
        contactName: "Jane Doe",
        paymentTerms: "Net 30",
      });
      // Explicitly assert PII / internal fields are absent.
      expect(snap.vendor).not.toHaveProperty("contact_email");
      expect(snap.vendor).not.toHaveProperty("contactEmail");
      expect(snap.vendor).not.toHaveProperty("notes");
      const serialized = JSON.stringify(snap);
      expect(serialized).not.toContain("jane@acme.test");
      expect(serialized).not.toContain("internal note about Acme");
    });

    test("missing optional vendor fields become null", async () => {
      vendorDomain.getVendor.mockResolvedValue({ vendorId: "V2", name: "Beta" });
      campaignDomain.queryCampaignsByDateRange.mockResolvedValue([]);
      const snap = await buildVendorReportSnapshot({
        vendorId: "V2",
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      expect(snap.vendor).toEqual({
        id: "V2",
        name: "Beta",
        website: null,
        contactName: null,
        paymentTerms: null,
      });
    });
  });

  describe("report envelope", () => {
    test("schemaVersion, generatedAt, dataAsOf, currency, null id", async () => {
      campaignDomain.queryCampaignsByDateRange.mockResolvedValue([]);
      const snap = await buildVendorReportSnapshot({
        vendorId: "V1",
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      expect(snap.schemaVersion).toBe(1);
      expect(snap.report.id).toBeNull();
      expect(snap.report.currency).toBe("USD");
      expect(snap.report.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
      expect(snap.report.dataAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(snap.report.dataAsOf).toBe(snap.report.generatedAt.slice(0, 10));
    });

    test("passes the GSI date range straight to the query", async () => {
      campaignDomain.queryCampaignsByDateRange.mockResolvedValue([]);
      await buildVendorReportSnapshot({
        vendorId: "V1",
        startDate: "2026-03-01",
        endDate: "2026-06-30",
      });
      expect(campaignDomain.queryCampaignsByDateRange).toHaveBeenCalledWith({
        startDate: "2026-03-01",
        endDate: "2026-06-30",
      });
    });
  });

  describe("period label logic", () => {
    test("full calendar year -> YYYY", async () => {
      campaignDomain.queryCampaignsByDateRange.mockResolvedValue([]);
      const snap = await buildVendorReportSnapshot({
        vendorId: "V1",
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      expect(snap.report.period.label).toBe("2026");
    });

    test("partial range -> 'startDate – endDate'", async () => {
      campaignDomain.queryCampaignsByDateRange.mockResolvedValue([]);
      const snap = await buildVendorReportSnapshot({
        vendorId: "V1",
        startDate: "2026-03-01",
        endDate: "2026-06-30",
      });
      expect(snap.report.period.label).toBe("2026-03-01 – 2026-06-30");
    });

    test("cross-year full range is not labeled as a single year", async () => {
      campaignDomain.queryCampaignsByDateRange.mockResolvedValue([]);
      const snap = await buildVendorReportSnapshot({
        vendorId: "V1",
        startDate: "2025-01-01",
        endDate: "2026-12-31",
      });
      expect(snap.report.period.label).toBe("2025-01-01 – 2026-12-31");
    });
  });

  describe("vendor + payout filtering", () => {
    test("skips campaigns for other vendors and campaigns with no payout", async () => {
      campaignDomain.queryCampaignsByDateRange.mockResolvedValue([
        campaign({ campaignId: "C1", vendorId: "OTHER", createdAt: "2026-02-01T00:00:00.000Z", amount: 500 }),
        campaign({ campaignId: "C2", vendorId: "V1", createdAt: "2026-02-01T00:00:00.000Z" }), // no payout
        campaign({ campaignId: "C3", vendorId: "V1", createdAt: "2026-02-01T00:00:00.000Z", amount: 100 }),
      ]);
      const snap = await buildVendorReportSnapshot({
        vendorId: "V1",
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      expect(snap.campaigns.map((c) => c.campaignId)).toEqual(["C3"]);
      expect(snap.summary.campaignCount).toBe(1);
    });

    test("skips campaigns whose booked and received dates are both out of window", async () => {
      campaignDomain.queryCampaignsByDateRange.mockResolvedValue([
        campaign({ campaignId: "C1", createdAt: "2025-12-31T00:00:00.000Z", amount: 100 }),
      ]);
      const snap = await buildVendorReportSnapshot({
        vendorId: "V1",
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      expect(snap.campaigns).toEqual([]);
      expect(snap.summary.campaignCount).toBe(0);
    });
  });

  describe("non-USD skipped handling", () => {
    test("non-USD campaigns are skipped with the revenue.mjs reason shape", async () => {
      campaignDomain.queryCampaignsByDateRange.mockResolvedValue([
        campaign({ campaignId: "C1", createdAt: "2026-02-01T00:00:00.000Z", amount: 200, currency: "EUR" }),
        campaign({ campaignId: "C2", createdAt: "2026-02-01T00:00:00.000Z", amount: 100, currency: "USD" }),
      ]);
      const snap = await buildVendorReportSnapshot({
        vendorId: "V1",
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      expect(snap.skipped).toEqual([
        {
          campaignId: "C1",
          currency: "EUR",
          amount: 200,
          reason: "currency EUR not aggregated; only USD is supported",
        },
      ]);
      expect(snap.campaigns.map((c) => c.campaignId)).toEqual(["C2"]);
      expect(snap.summary.totalBookedAmount).toBe(100);
    });
  });

  describe("aggregation math", () => {
    test("booked vs received vs outstanding, paid/unpaid counts", async () => {
      campaignDomain.queryCampaignsByDateRange.mockResolvedValue([
        // booked + received (paid in window)
        campaign({ campaignId: "C1", createdAt: "2026-01-15T00:00:00.000Z", amount: 100, paid: true, paidAt: "2026-02-01" }),
        // booked only (unpaid)
        campaign({ campaignId: "C2", createdAt: "2026-02-10T00:00:00.000Z", amount: 200, paid: false }),
        // booked + received, larger received making outstanding clamp at 0 only when received>booked overall
        campaign({ campaignId: "C3", createdAt: "2026-03-05T00:00:00.000Z", amount: 50, paid: true, paidAt: "2026-03-20" }),
      ]);
      const snap = await buildVendorReportSnapshot({
        vendorId: "V1",
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });

      // booked = 100 + 200 + 50 = 350; received = 100 + 50 = 150
      expect(snap.summary.totalBookedAmount).toBe(350);
      expect(snap.summary.totalReceivedAmount).toBe(150);
      expect(snap.summary.outstandingAmount).toBe(200);
      expect(snap.summary.campaignCount).toBe(3);
      expect(snap.summary.paidCount).toBe(2);
      expect(snap.summary.unpaidCount).toBe(1);
    });

    test("outstanding clamps to 0 when received exceeds booked", async () => {
      // A campaign booked before the window but received inside it: received
      // counts, booked does not — received can exceed booked-in-window.
      campaignDomain.queryCampaignsByDateRange.mockResolvedValue([
        campaign({ campaignId: "C1", createdAt: "2025-12-20T00:00:00.000Z", amount: 300, paid: true, paidAt: "2026-01-05" }),
      ]);
      const snap = await buildVendorReportSnapshot({
        vendorId: "V1",
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      expect(snap.summary.totalBookedAmount).toBe(0);
      expect(snap.summary.totalReceivedAmount).toBe(300);
      expect(snap.summary.outstandingAmount).toBe(0);
      expect(snap.summary.campaignCount).toBe(1);
    });

    test("status and paidAt are mapped per campaign", async () => {
      campaignDomain.queryCampaignsByDateRange.mockResolvedValue([
        campaign({ campaignId: "C1", name: "Paid one", createdAt: "2026-01-15T12:00:00.000Z", amount: 100, paid: true, paidAt: "2026-02-01" }),
        campaign({ campaignId: "C2", name: "Booked one", createdAt: "2026-02-10T00:00:00.000Z", amount: 200, paid: false }),
      ]);
      const snap = await buildVendorReportSnapshot({
        vendorId: "V1",
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      expect(snap.campaigns).toEqual([
        { campaignId: "C1", name: "Paid one", bookedDate: "2026-01-15", amount: 100, currency: "USD", status: "paid", paidAt: "2026-02-01" },
        { campaignId: "C2", name: "Booked one", bookedDate: "2026-02-10", amount: 200, currency: "USD", status: "booked", paidAt: null },
      ]);
    });
  });

  describe("monthly grouping", () => {
    test("groups by booked month, sorted ascending, with per-month booked/received", async () => {
      campaignDomain.queryCampaignsByDateRange.mockResolvedValue([
        campaign({ campaignId: "C1", createdAt: "2026-03-01T00:00:00.000Z", amount: 50, paid: true, paidAt: "2026-03-15" }),
        campaign({ campaignId: "C2", createdAt: "2026-01-10T00:00:00.000Z", amount: 100, paid: false }),
        campaign({ campaignId: "C3", createdAt: "2026-01-25T00:00:00.000Z", amount: 200, paid: true, paidAt: "2026-04-01" }),
      ]);
      const snap = await buildVendorReportSnapshot({
        vendorId: "V1",
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      expect(snap.monthly).toEqual([
        { month: "2026-01", bookedAmount: 300, receivedAmount: 200, campaignCount: 2 },
        { month: "2026-03", bookedAmount: 50, receivedAmount: 50, campaignCount: 1 },
      ]);
    });
  });
});
