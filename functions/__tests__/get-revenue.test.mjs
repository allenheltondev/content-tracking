import { jest } from "@jest/globals";
import { marshall } from "@aws-sdk/util-dynamodb";

const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");

process.env.TABLE_NAME = "test-content-tracking";

const { handler } = await import("../get-revenue.mjs");

describe("get-revenue", () => {
  let mockDdbSend;

  beforeEach(() => {
    mockDdbSend = jest.fn();
    DynamoDBClient.prototype.send = mockDdbSend;
    jest.clearAllMocks();
  });

  const campaignRow = (overrides) => marshall({
    pk: `CAMPAIGN#${overrides.campaignId}`,
    sk: "METADATA",
    entity: "Campaign",
    name: overrides.name || "Campaign",
    status: "active",
    createdAt: overrides.createdAt || "2026-05-01T00:00:00.000Z",
    ...overrides,
  });

  const invoke = (qs = {}) => handler({ queryStringParameters: qs });

  describe("validation", () => {
    test("returns 400 when year is malformed", async () => {
      const res = await invoke({ year: "abc" });
      expect(res.statusCode).toBe(400);
    });

    test("returns 400 when year + startDate are both provided", async () => {
      const res = await invoke({ year: "2026", startDate: "2026-01-01" });
      expect(res.statusCode).toBe(400);
    });

    test("returns 400 when vendorId is not a ULID", async () => {
      const res = await invoke({ vendorId: "abc" });
      expect(res.statusCode).toBe(400);
    });

    test("returns 400 when grouping is invalid", async () => {
      const res = await invoke({ grouping: "week" });
      expect(res.statusCode).toBe(400);
    });

    test("returns 400 when paidOnly is not a boolean string", async () => {
      const res = await invoke({ paidOnly: "yes" });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("aggregation", () => {
    test("sums USD payouts and surfaces non-USD in skipped", async () => {
      mockDdbSend.mockResolvedValue({
        Items: [
          campaignRow({
            campaignId: "01HV0AABBCCDDEEFFGGHHJJKKM",
            createdAt: "2026-03-01T00:00:00.000Z",
            payout: { amount: 5000, currency: "USD", paid: true, paid_at: "2026-03-15" },
          }),
          campaignRow({
            campaignId: "01HV0AABBCCDDEEFFGGHHJJKKN",
            createdAt: "2026-04-01T00:00:00.000Z",
            payout: { amount: 1200, currency: "USD", paid: false },
          }),
          campaignRow({
            campaignId: "01HV0AABBCCDDEEFFGGHHJJKKP",
            createdAt: "2026-04-15T00:00:00.000Z",
            payout: { amount: 800, currency: "EUR", paid: true, paid_at: "2026-04-20" },
          }),
        ],
      });

      const res = await invoke({ year: "2026", grouping: "month" });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(body.currency).toBe("USD");
      expect(body.booked.amount).toBe(6200);   // 5000 + 1200, EUR skipped
      expect(body.booked.campaignCount).toBe(2);
      expect(body.received.amount).toBe(5000); // only the paid USD one
      expect(body.received.campaignCount).toBe(1);

      expect(body.skipped.length).toBe(1);
      expect(body.skipped[0].currency).toBe("EUR");
    });

    test("excludes campaigns outside the year window", async () => {
      mockDdbSend.mockResolvedValue({
        Items: [
          campaignRow({
            campaignId: "01HV0AABBCCDDEEFFGGHHJJKKM",
            createdAt: "2025-12-01T00:00:00.000Z",
            payout: { amount: 5000, currency: "USD", paid: true, paid_at: "2025-12-15" },
          }),
          campaignRow({
            campaignId: "01HV0AABBCCDDEEFFGGHHJJKKN",
            createdAt: "2026-03-01T00:00:00.000Z",
            payout: { amount: 1200, currency: "USD", paid: false },
          }),
        ],
      });

      const res = await invoke({ year: "2026" });
      const body = JSON.parse(res.body);
      expect(body.booked.amount).toBe(1200);
      expect(body.booked.campaignCount).toBe(1);
    });

    test("paidOnly=true returns only campaigns marked paid in the window", async () => {
      mockDdbSend.mockResolvedValue({
        Items: [
          campaignRow({
            campaignId: "01HV0AABBCCDDEEFFGGHHJJKKM",
            createdAt: "2026-03-01T00:00:00.000Z",
            payout: { amount: 5000, currency: "USD", paid: true, paid_at: "2026-03-15" },
          }),
          campaignRow({
            campaignId: "01HV0AABBCCDDEEFFGGHHJJKKN",
            createdAt: "2026-04-01T00:00:00.000Z",
            payout: { amount: 1200, currency: "USD", paid: false },
          }),
        ],
      });

      const res = await invoke({ year: "2026", paidOnly: "true" });
      const body = JSON.parse(res.body);
      expect(body.received.amount).toBe(5000);
      expect(body.booked.amount).toBe(5000);
      expect(body.total.campaignCount).toBe(1);
    });

    test("vendorId filter scopes to one vendor", async () => {
      mockDdbSend.mockResolvedValue({
        Items: [
          campaignRow({
            campaignId: "01HV0AABBCCDDEEFFGGHHJJKKM",
            vendorId: "01HVAABBCCDDEEFFGGHHJJKKMN",
            createdAt: "2026-03-01T00:00:00.000Z",
            payout: { amount: 5000, currency: "USD", paid: false },
          }),
          campaignRow({
            campaignId: "01HV0AABBCCDDEEFFGGHHJJKKN",
            vendorId: "01HVAABBCCDDEEFFGGHHJJKKMP",
            createdAt: "2026-03-01T00:00:00.000Z",
            payout: { amount: 1200, currency: "USD", paid: false },
          }),
        ],
      });

      const res = await invoke({ year: "2026", vendorId: "01HVAABBCCDDEEFFGGHHJJKKMN" });
      const body = JSON.parse(res.body);
      expect(body.booked.amount).toBe(5000);
    });

    test("groups by month for grouping=month (default)", async () => {
      mockDdbSend.mockResolvedValue({
        Items: [
          campaignRow({
            campaignId: "01HV0AABBCCDDEEFFGGHHJJKKM",
            createdAt: "2026-03-01T00:00:00.000Z",
            payout: { amount: 5000, currency: "USD", paid: false },
          }),
          campaignRow({
            campaignId: "01HV0AABBCCDDEEFFGGHHJJKKN",
            createdAt: "2026-03-15T00:00:00.000Z",
            payout: { amount: 1000, currency: "USD", paid: false },
          }),
          campaignRow({
            campaignId: "01HV0AABBCCDDEEFFGGHHJJKKP",
            createdAt: "2026-05-01T00:00:00.000Z",
            payout: { amount: 2000, currency: "USD", paid: false },
          }),
        ],
      });

      const res = await invoke({ year: "2026" });
      const body = JSON.parse(res.body);
      expect(body.groups.length).toBe(2);
      expect(body.groups[0]).toMatchObject({ key: "2026-03", amount: 6000, campaignCount: 2 });
      expect(body.groups[1]).toMatchObject({ key: "2026-05", amount: 2000, campaignCount: 1 });
    });

    test("groups by vendor for grouping=vendor", async () => {
      mockDdbSend.mockResolvedValue({
        Items: [
          campaignRow({
            campaignId: "01HV0AABBCCDDEEFFGGHHJJKKM",
            vendorId: "01HVAABBCCDDEEFFGGHHJJKKMN",
            createdAt: "2026-03-01T00:00:00.000Z",
            payout: { amount: 5000, currency: "USD", paid: false },
          }),
          campaignRow({
            campaignId: "01HV0AABBCCDDEEFFGGHHJJKKN",
            createdAt: "2026-04-01T00:00:00.000Z",
            payout: { amount: 1200, currency: "USD", paid: false },
          }),
        ],
      });

      const res = await invoke({ year: "2026", grouping: "vendor" });
      const body = JSON.parse(res.body);
      expect(body.groups.length).toBe(2);
      const keys = body.groups.map((g) => g.key).sort();
      expect(keys).toEqual(["01HVAABBCCDDEEFFGGHHJJKKMN", "unassigned"]);
    });

    test("returns empty groups + zero totals when no campaigns match", async () => {
      mockDdbSend.mockResolvedValue({ Items: [] });
      const res = await invoke({ year: "2026" });
      const body = JSON.parse(res.body);
      expect(body.total.amount).toBe(0);
      expect(body.total.campaignCount).toBe(0);
      expect(body.groups).toEqual([]);
      expect(body.skipped).toEqual([]);
    });
  });
});
