import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";
process.env.ENVIRONMENT = "staging";

// Mock every collaborator so the route logic is exercised in isolation:
// the snapshot builder, the HTML renderer, the S3 store + signer, and the
// record persistence layer.
jest.unstable_mockModule("../domain/vendor-report.mjs", () => ({
  buildVendorReportSnapshot: jest.fn(),
}));
jest.unstable_mockModule("../services/report-renderer.mjs", () => ({
  renderVendorReportHtml: jest.fn(),
}));
jest.unstable_mockModule("../services/vendor-report-store.mjs", () => ({
  putReportHtml: jest.fn(),
  signReportUrl: jest.fn(),
  SIGNED_URL_TTL_SECONDS: 7 * 24 * 60 * 60,
}));
jest.unstable_mockModule("../domain/vendor-report-record.mjs", () => ({
  saveReportRecord: jest.fn(),
  listReportRecords: jest.fn(),
  reportObjectExpiresAtMs: jest.fn(),
}));
jest.unstable_mockModule("../domain/vendor.mjs", () => ({
  assertVendorOwned: jest.fn().mockResolvedValue(undefined),
}));
jest.unstable_mockModule("../services/identity.mjs", () => ({
  requireTenantId: jest.fn(() => "user-1"),
}));

const { buildVendorReportSnapshot } = await import("../domain/vendor-report.mjs");
const { renderVendorReportHtml } = await import("../services/report-renderer.mjs");
const { putReportHtml, signReportUrl } = await import("../services/vendor-report-store.mjs");
const { saveReportRecord, listReportRecords, reportObjectExpiresAtMs } = await import(
  "../domain/vendor-report-record.mjs"
);
const { NotFoundError } = await import("../services/errors.mjs");
const { registerVendorReportRoutes } = await import("../routes/vendor-reports.mjs");

// Capture the handlers the route module registers so we can call them
// directly with synthetic { event, params } the way the Router would.
function buildRouteTable() {
  const routes = {};
  const app = {
    post: (path, handler) => { routes[`POST ${path}`] = handler; },
    get: (path, handler) => { routes[`GET ${path}`] = handler; },
  };
  registerVendorReportRoutes(app);
  return routes;
}

const routes = buildRouteTable();
const postReport = routes["POST /vendors/:vendorId/report"];
const getReports = routes["GET /vendors/:vendorId/reports"];

function makeSnapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    report: {
      id: null,
      generatedAt: "2026-05-29T10:00:00.000Z",
      dataAsOf: "2026-05-29",
      period: { startDate: "2026-01-01", endDate: "2026-12-31", label: "2026" },
      currency: "USD",
    },
    vendor: { id: "acme", name: "Acme" },
    summary: {
      totalBookedAmount: 1000,
      totalReceivedAmount: 400,
      outstandingAmount: 600,
      campaignCount: 3,
      paidCount: 1,
      unpaidCount: 2,
    },
    monthly: [],
    campaigns: [],
    skipped: [],
    ...overrides,
  };
}

describe("routes/vendor-reports", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: every record's object outlives any link we'd mint, so the
    // list endpoint's staleness filter keeps them. Individual tests override.
    reportObjectExpiresAtMs.mockReturnValue(Date.now() + 365 * 24 * 60 * 60 * 1000);
  });

  describe("registration", () => {
    test("registers the POST and GET routes", () => {
      expect(typeof postReport).toBe("function");
      expect(typeof getReports).toBe("function");
    });
  });

  describe("POST /vendors/:vendorId/report", () => {
    test("happy path: assigns reportId, stores html, signs url, saves record, returns 201", async () => {
      const snapshot = makeSnapshot();
      buildVendorReportSnapshot.mockResolvedValue(snapshot);
      renderVendorReportHtml.mockReturnValue("<html>report</html>");
      putReportHtml.mockResolvedValue("reports/acme/RID.html");
      signReportUrl.mockReturnValue({
        url: "https://cdn.example.com/reports/acme/RID.html?sig",
        expiresAt: "2026-06-05T10:00:00.000Z",
      });
      saveReportRecord.mockResolvedValue({});

      const res = await postReport({ event: { body: null }, params: { vendorId: "acme" } });

      // reportId assigned onto the snapshot before render + persistence.
      expect(snapshot.report.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(renderVendorReportHtml).toHaveBeenCalledWith(snapshot);

      // HTML stored under the right vendor/report key with the generated id.
      const putArg = putReportHtml.mock.calls[0][0];
      expect(putArg.vendorId).toBe("acme");
      expect(putArg.reportId).toBe(snapshot.report.id);
      expect(putArg.html).toBe("<html>report</html>");

      // URL signed for the stored key.
      expect(signReportUrl).toHaveBeenCalledWith("reports/acme/RID.html");

      // Record persisted with metadata (not the body).
      const recordArg = saveReportRecord.mock.calls[0][0];
      expect(recordArg).toMatchObject({
        vendorId: "acme",
        reportId: snapshot.report.id,
        key: "reports/acme/RID.html",
        generatedAt: "2026-05-29T10:00:00.000Z",
        dataAsOf: "2026-05-29",
        currency: "USD",
        period: { startDate: "2026-01-01", endDate: "2026-12-31", label: "2026" },
        summary: snapshot.summary,
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body).toEqual({
        reportId: snapshot.report.id,
        url: "https://cdn.example.com/reports/acme/RID.html?sig",
        expiresAt: "2026-06-05T10:00:00.000Z",
        dataAsOf: "2026-05-29",
        period: { startDate: "2026-01-01", endDate: "2026-12-31", label: "2026" },
        currency: "USD",
        summary: snapshot.summary,
      });
    });

    test("defaults period to current year when no body/query supplied", async () => {
      buildVendorReportSnapshot.mockResolvedValue(makeSnapshot());
      renderVendorReportHtml.mockReturnValue("<html></html>");
      putReportHtml.mockResolvedValue("k");
      signReportUrl.mockReturnValue({ url: "u", expiresAt: "e" });
      saveReportRecord.mockResolvedValue({});

      await postReport({ event: { body: null }, params: { vendorId: "acme" } });

      const year = new Date().getUTCFullYear();
      expect(buildVendorReportSnapshot).toHaveBeenCalledWith({
        vendorId: "acme",
        startDate: `${year}-01-01`,
        endDate: `${year}-12-31`,
        tenantId: "user-1",
      });
    });

    test("parses explicit year from JSON body", async () => {
      buildVendorReportSnapshot.mockResolvedValue(makeSnapshot());
      renderVendorReportHtml.mockReturnValue("<html></html>");
      putReportHtml.mockResolvedValue("k");
      signReportUrl.mockReturnValue({ url: "u", expiresAt: "e" });
      saveReportRecord.mockResolvedValue({});

      await postReport({
        event: { body: JSON.stringify({ year: 2024 }) },
        params: { vendorId: "acme" },
      });

      expect(buildVendorReportSnapshot).toHaveBeenCalledWith({
        vendorId: "acme",
        startDate: "2024-01-01",
        endDate: "2024-12-31",
        tenantId: "user-1",
      });
    });

    test("parses explicit startDate/endDate range from body", async () => {
      buildVendorReportSnapshot.mockResolvedValue(makeSnapshot());
      renderVendorReportHtml.mockReturnValue("<html></html>");
      putReportHtml.mockResolvedValue("k");
      signReportUrl.mockReturnValue({ url: "u", expiresAt: "e" });
      saveReportRecord.mockResolvedValue({});

      await postReport({
        event: { body: JSON.stringify({ startDate: "2026-03-01", endDate: "2026-03-31" }) },
        params: { vendorId: "acme" },
      });

      expect(buildVendorReportSnapshot).toHaveBeenCalledWith({
        vendorId: "acme",
        startDate: "2026-03-01",
        endDate: "2026-03-31",
        tenantId: "user-1",
      });
    });

    test("falls back to query string params when body absent", async () => {
      buildVendorReportSnapshot.mockResolvedValue(makeSnapshot());
      renderVendorReportHtml.mockReturnValue("<html></html>");
      putReportHtml.mockResolvedValue("k");
      signReportUrl.mockReturnValue({ url: "u", expiresAt: "e" });
      saveReportRecord.mockResolvedValue({});

      await postReport({
        event: { body: null, queryStringParameters: { year: "2023" } },
        params: { vendorId: "acme" },
      });

      expect(buildVendorReportSnapshot).toHaveBeenCalledWith({
        vendorId: "acme",
        startDate: "2023-01-01",
        endDate: "2023-12-31",
        tenantId: "user-1",
      });
    });

    test("400 on invalid vendorId", async () => {
      await expect(
        postReport({ event: { body: null }, params: { vendorId: "bad id!" } }),
      ).rejects.toThrow(/vendorId must be/);
      expect(buildVendorReportSnapshot).not.toHaveBeenCalled();
    });

    test("400 on malformed date", async () => {
      await expect(
        postReport({
          event: { body: JSON.stringify({ startDate: "2026/01/01" }) },
          params: { vendorId: "acme" },
        }),
      ).rejects.toThrow(/startDate must be YYYY-MM-DD/);
    });

    test("400 when both year and date range supplied", async () => {
      await expect(
        postReport({
          event: { body: JSON.stringify({ year: 2026, startDate: "2026-01-01" }) },
          params: { vendorId: "acme" },
        }),
      ).rejects.toThrow(/either year or startDate\/endDate/);
    });

    test("400 on out-of-range year", async () => {
      await expect(
        postReport({
          event: { body: JSON.stringify({ year: 1800 }) },
          params: { vendorId: "acme" },
        }),
      ).rejects.toThrow(/year must be an integer/);
    });

    test("400 on invalid JSON body", async () => {
      await expect(
        postReport({ event: { body: "{not json" }, params: { vendorId: "acme" } }),
      ).rejects.toThrow(/Invalid JSON body/);
    });

    test("propagates NotFoundError from the snapshot builder", async () => {
      buildVendorReportSnapshot.mockRejectedValue(new NotFoundError("Vendor", "ghost"));
      await expect(
        postReport({ event: { body: null }, params: { vendorId: "ghost" } }),
      ).rejects.toThrow(/Vendor ghost not found/);
      expect(putReportHtml).not.toHaveBeenCalled();
      expect(saveReportRecord).not.toHaveBeenCalled();
    });
  });

  describe("GET /vendors/:vendorId/reports", () => {
    test("re-signs a fresh URL for each stored record, newest first", async () => {
      listReportRecords.mockResolvedValue([
        {
          reportId: "R2",
          key: "reports/acme/R2.html",
          generatedAt: "2026-05-29T10:00:00.000Z",
          dataAsOf: "2026-05-29",
          period: { startDate: "2026-01-01", endDate: "2026-12-31", label: "2026" },
          currency: "USD",
        },
        {
          reportId: "R1",
          key: "reports/acme/R1.html",
          generatedAt: "2026-04-01T10:00:00.000Z",
          dataAsOf: "2026-04-01",
          period: { startDate: "2025-01-01", endDate: "2025-12-31", label: "2025" },
          currency: "USD",
        },
      ]);
      signReportUrl
        .mockReturnValueOnce({ url: "https://cdn/r2?fresh", expiresAt: "2026-06-05T10:00:00.000Z" })
        .mockReturnValueOnce({ url: "https://cdn/r1?fresh", expiresAt: "2026-06-05T10:00:00.000Z" });

      const res = await getReports({ params: { vendorId: "acme" } });

      expect(listReportRecords).toHaveBeenCalledWith("acme");
      expect(signReportUrl).toHaveBeenNthCalledWith(1, "reports/acme/R2.html");
      expect(signReportUrl).toHaveBeenNthCalledWith(2, "reports/acme/R1.html");

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.vendor_id).toBe("acme");
      expect(body.reports).toEqual([
        {
          reportId: "R2",
          generatedAt: "2026-05-29T10:00:00.000Z",
          dataAsOf: "2026-05-29",
          period: { startDate: "2026-01-01", endDate: "2026-12-31", label: "2026" },
          currency: "USD",
          url: "https://cdn/r2?fresh",
          expiresAt: "2026-06-05T10:00:00.000Z",
        },
        {
          reportId: "R1",
          generatedAt: "2026-04-01T10:00:00.000Z",
          dataAsOf: "2026-04-01",
          period: { startDate: "2025-01-01", endDate: "2025-12-31", label: "2025" },
          currency: "USD",
          url: "https://cdn/r1?fresh",
          expiresAt: "2026-06-05T10:00:00.000Z",
        },
      ]);
    });

    test("skips records whose S3 object would expire before the fresh link", async () => {
      const live = {
        reportId: "LIVE",
        key: "reports/acme/LIVE.html",
        generatedAt: "2026-05-20T10:00:00.000Z",
        dataAsOf: "2026-05-20",
        period: { startDate: "2026-01-01", endDate: "2026-12-31", label: "2026" },
        currency: "USD",
      };
      const stale = {
        reportId: "STALE",
        key: "reports/acme/STALE.html",
        generatedAt: "2025-01-01T10:00:00.000Z",
        dataAsOf: "2025-01-01",
        period: { startDate: "2025-01-01", endDate: "2025-12-31", label: "2025" },
        currency: "USD",
      };
      listReportRecords.mockResolvedValue([live, stale]);
      // Live object outlives the link; stale object is already gone.
      reportObjectExpiresAtMs.mockImplementation((r) =>
        r.reportId === "LIVE" ? Date.now() + 30 * 24 * 60 * 60 * 1000 : Date.now() - 1000,
      );
      signReportUrl.mockReturnValue({ url: "https://cdn/live?fresh", expiresAt: "2026-06-05T10:00:00.000Z" });

      const res = await getReports({ params: { vendorId: "acme" } });

      // Only the live report is returned, and we never sign the stale key.
      expect(signReportUrl).toHaveBeenCalledTimes(1);
      expect(signReportUrl).toHaveBeenCalledWith("reports/acme/LIVE.html");
      const body = JSON.parse(res.body);
      expect(body.reports.map((r) => r.reportId)).toEqual(["LIVE"]);
    });

    test("returns an empty list when the vendor has no reports", async () => {
      listReportRecords.mockResolvedValue([]);
      const res = await getReports({ params: { vendorId: "acme" } });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ vendor_id: "acme", reports: [] });
      expect(signReportUrl).not.toHaveBeenCalled();
    });

    test("400 on invalid vendorId", async () => {
      await expect(getReports({ params: { vendorId: "bad id!" } })).rejects.toThrow(/vendorId must be/);
      expect(listReportRecords).not.toHaveBeenCalled();
    });
  });
});
