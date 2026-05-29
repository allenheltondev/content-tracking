import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";
// Pin retention so the TTL math is deterministic regardless of the
// deploy-time parameter. The module reads this at import.
process.env.VENDOR_REPORTS_RETENTION_DAYS = "90";

const send = jest.fn();
jest.unstable_mockModule("../services/ddb.mjs", () => ({
  TABLE_NAME: "test-booked",
  ddb: { send },
}));

const {
  saveReportRecord,
  listReportRecords,
  reportObjectExpiresAtMs,
  REPORT_RETENTION_DAYS,
} = await import("../domain/vendor-report-record.mjs");

const RETENTION_SECONDS = 90 * 24 * 60 * 60;
const RETENTION_MS = RETENTION_SECONDS * 1000;

const baseRecord = {
  vendorId: "acme",
  reportId: "01J0RID",
  key: "reports/acme/01J0RID.html",
  generatedAt: "2026-01-01T00:00:00.000Z",
  dataAsOf: "2026-01-01",
  period: { startDate: "2026-01-01", endDate: "2026-12-31", label: "2026" },
  currency: "USD",
  summary: { totalBookedAmount: 0 },
};

describe("domain/vendor-report-record", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    send.mockResolvedValue({});
  });

  test("retention matches the configured parameter", () => {
    expect(REPORT_RETENTION_DAYS).toBe(90);
  });

  describe("saveReportRecord", () => {
    test("writes a TTL (expiresAt) keyed off generatedAt + retention", async () => {
      await saveReportRecord(baseRecord);

      const command = send.mock.calls[0][0];
      const item = command.input.Item;
      const expectedTtl = Math.floor(Date.parse(baseRecord.generatedAt) / 1000) + RETENTION_SECONDS;
      expect(item.expiresAt).toBe(expectedTtl);
      // TTL is a Number (epoch seconds), which DynamoDB requires.
      expect(typeof item.expiresAt).toBe("number");
      expect(item).toMatchObject({
        pk: "VENDOR#acme",
        sk: "REPORT#01J0RID",
        entity: "VendorReport",
        key: "reports/acme/01J0RID.html",
      });
    });

    test("falls back to now for an unparseable generatedAt rather than a never-expiring record", async () => {
      const before = Math.floor(Date.now() / 1000);
      await saveReportRecord({ ...baseRecord, generatedAt: "not-a-date" });
      const after = Math.floor(Date.now() / 1000);

      const item = send.mock.calls[0][0].input.Item;
      expect(item.expiresAt).toBeGreaterThanOrEqual(before + RETENTION_SECONDS);
      expect(item.expiresAt).toBeLessThanOrEqual(after + RETENTION_SECONDS);
    });
  });

  describe("reportObjectExpiresAtMs", () => {
    test("returns generatedAt + retention in ms", () => {
      expect(reportObjectExpiresAtMs({ generatedAt: "2026-01-01T00:00:00.000Z" })).toBe(
        Date.parse("2026-01-01T00:00:00.000Z") + RETENTION_MS,
      );
    });

    test("returns 0 (treat as expired) for a missing or unparseable generatedAt", () => {
      expect(reportObjectExpiresAtMs({})).toBe(0);
      expect(reportObjectExpiresAtMs({ generatedAt: "nope" })).toBe(0);
      expect(reportObjectExpiresAtMs(undefined)).toBe(0);
    });
  });

  describe("listReportRecords", () => {
    test("queries the vendor partition and returns records newest-first", async () => {
      send.mockResolvedValue({
        Items: [
          { reportId: "old", generatedAt: "2026-01-01T00:00:00.000Z" },
          { reportId: "new", generatedAt: "2026-05-01T00:00:00.000Z" },
        ],
      });

      const result = await listReportRecords("acme");

      const command = send.mock.calls[0][0];
      expect(command.input.ExpressionAttributeValues).toMatchObject({
        ":pk": "VENDOR#acme",
        ":prefix": "REPORT#",
      });
      expect(result.map((r) => r.reportId)).toEqual(["new", "old"]);
    });
  });
});
