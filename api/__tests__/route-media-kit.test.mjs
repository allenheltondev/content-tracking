import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";
process.env.ENVIRONMENT = "staging";

// Mock every collaborator so the route logic is exercised in isolation: the
// snapshot builder, the HTML renderer, the S3 store, the record persistence
// layer, and the REUSED generic signer + retention helper from the vendor
// modules.
jest.unstable_mockModule("../domain/media-kit.mjs", () => ({
  buildMediaKitSnapshot: jest.fn(),
}));
jest.unstable_mockModule("../services/media-kit-renderer.mjs", () => ({
  renderMediaKitHtml: jest.fn(),
}));
jest.unstable_mockModule("../services/media-kit-store.mjs", () => ({
  putMediaKitHtml: jest.fn(),
}));
jest.unstable_mockModule("../services/vendor-report-store.mjs", () => ({
  signReportUrl: jest.fn(),
  SIGNED_URL_TTL_SECONDS: 7 * 24 * 60 * 60,
}));
jest.unstable_mockModule("../domain/media-kit-record.mjs", () => ({
  saveMediaKitRecord: jest.fn(),
  listMediaKitRecords: jest.fn(),
}));
jest.unstable_mockModule("../domain/vendor-report-record.mjs", () => ({
  reportObjectExpiresAtMs: jest.fn(),
  REPORT_RETENTION_DAYS: 90,
}));
jest.unstable_mockModule("../services/newsletter-service.mjs", () => ({
  mintShortLink: jest.fn(),
}));
jest.unstable_mockModule("../services/identity.mjs", () => ({
  requireTenantId: jest.fn(() => "user-1"),
}));

const { buildMediaKitSnapshot } = await import("../domain/media-kit.mjs");
const { renderMediaKitHtml } = await import("../services/media-kit-renderer.mjs");
const { putMediaKitHtml } = await import("../services/media-kit-store.mjs");
const { signReportUrl } = await import("../services/vendor-report-store.mjs");
const { saveMediaKitRecord, listMediaKitRecords } = await import("../domain/media-kit-record.mjs");
const { reportObjectExpiresAtMs } = await import("../domain/vendor-report-record.mjs");
const { mintShortLink } = await import("../services/newsletter-service.mjs");
const { registerMediaKitRoutes } = await import("../routes/media-kit.mjs");

function buildRouteTable() {
  const routes = {};
  const app = {
    post: (path, handler) => { routes[`POST ${path}`] = handler; },
    get: (path, handler) => { routes[`GET ${path}`] = handler; },
  };
  registerMediaKitRoutes(app);
  return routes;
}

const routes = buildRouteTable();
const postKit = routes["POST /media-kit"];
const getKits = routes["GET /media-kit"];

const STATS = { totalFollowers: 15000, platformCount: 2, campaignsCompleted: 3 };

function makeSnapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    report: {
      id: null,
      generatedAt: "2026-05-29T10:00:00.000Z",
      dataAsOf: "2026-05-29",
      kind: "media-kit",
    },
    identity: { displayName: "Allen" },
    stats: STATS,
    ...overrides,
  };
}

describe("routes/media-kit", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    reportObjectExpiresAtMs.mockReturnValue(Date.now() + 365 * 24 * 60 * 60 * 1000);
  });

  describe("registration", () => {
    test("registers the POST and GET routes", () => {
      expect(typeof postKit).toBe("function");
      expect(typeof getKits).toBe("function");
    });
  });

  describe("POST /media-kit", () => {
    test("builds with the full ttl, stores html, signs url, saves record, returns 201", async () => {
      const snapshot = makeSnapshot();
      buildMediaKitSnapshot.mockResolvedValue(snapshot);
      renderMediaKitHtml.mockReturnValue("<html>kit</html>");
      putMediaKitHtml.mockResolvedValue("reports/media-kit/RID.html");
      signReportUrl.mockReturnValue({
        url: "https://cdn.example.com/reports/media-kit/RID.html?sig",
        expiresAt: "2026-08-27T10:00:00.000Z",
      });
      mintShortLink.mockResolvedValue({ short_url: "https://bkd.to/k1" });
      saveMediaKitRecord.mockResolvedValue({});

      const res = await postKit({ event: { body: null } });

      // reportId assigned before render + persistence, asset ttl = full window.
      expect(snapshot.report.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(buildMediaKitSnapshot).toHaveBeenCalledWith({
        assetUrlTtlSeconds: 90 * 24 * 60 * 60,
        tenantId: "user-1",
      });
      expect(renderMediaKitHtml).toHaveBeenCalledWith(snapshot);

      const putArg = putMediaKitHtml.mock.calls[0][0];
      expect(putArg.reportId).toBe(snapshot.report.id);
      expect(putArg.html).toBe("<html>kit</html>");

      expect(signReportUrl).toHaveBeenCalledWith("reports/media-kit/RID.html", {
        expiresInSeconds: 90 * 24 * 60 * 60,
      });
      expect(mintShortLink).toHaveBeenCalledWith({
        url: "https://cdn.example.com/reports/media-kit/RID.html?sig",
        src: "media-kit",
        expiresInDays: 90,
      });

      const recordArg = saveMediaKitRecord.mock.calls[0][0];
      expect(recordArg).toMatchObject({
        reportId: snapshot.report.id,
        key: "reports/media-kit/RID.html",
        generatedAt: "2026-05-29T10:00:00.000Z",
        dataAsOf: "2026-05-29",
        stats: STATS,
      });

      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.body)).toEqual({
        reportId: snapshot.report.id,
        url: "https://cdn.example.com/reports/media-kit/RID.html?sig",
        shortUrl: "https://bkd.to/k1",
        // generatedAt + 90-day retention window.
        expiresAt: "2026-08-27T10:00:00.000Z",
        dataAsOf: "2026-05-29",
        stats: STATS,
      });
    });

    test("returns shortUrl: null when the shortlink mint fails", async () => {
      buildMediaKitSnapshot.mockResolvedValue(makeSnapshot());
      renderMediaKitHtml.mockReturnValue("<html></html>");
      putMediaKitHtml.mockResolvedValue("k");
      signReportUrl.mockReturnValue({ url: "https://cdn/k.html?sig", expiresAt: "x" });
      mintShortLink.mockRejectedValue(new Error("upstream boom"));
      saveMediaKitRecord.mockResolvedValue({});

      const res = await postKit({ event: { body: null } });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.shortUrl).toBeNull();
      expect(body.url).toBe("https://cdn/k.html?sig");
      expect(saveMediaKitRecord).toHaveBeenCalled();
    });
  });

  describe("GET /media-kit", () => {
    test("re-signs a fresh URL for each stored record, newest first", async () => {
      listMediaKitRecords.mockResolvedValue([
        { reportId: "R2", key: "reports/media-kit/R2.html", generatedAt: "2026-05-29T10:00:00.000Z", dataAsOf: "2026-05-29", stats: STATS },
        { reportId: "R1", key: "reports/media-kit/R1.html", generatedAt: "2026-04-01T10:00:00.000Z", dataAsOf: "2026-04-01", stats: STATS },
      ]);
      const objectExpiryMs = Date.now() + 365 * 24 * 60 * 60 * 1000;
      reportObjectExpiresAtMs.mockReturnValue(objectExpiryMs);
      const expectedExpiresAt = new Date(objectExpiryMs).toISOString();
      signReportUrl
        .mockReturnValueOnce({ url: "https://cdn/r2?fresh", expiresAt: "ignored" })
        .mockReturnValueOnce({ url: "https://cdn/r1?fresh", expiresAt: "ignored" });

      const res = await getKits({});

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.media_kits).toEqual([
        { reportId: "R2", generatedAt: "2026-05-29T10:00:00.000Z", dataAsOf: "2026-05-29", stats: STATS, url: "https://cdn/r2?fresh", expiresAt: expectedExpiresAt },
        { reportId: "R1", generatedAt: "2026-04-01T10:00:00.000Z", dataAsOf: "2026-04-01", stats: STATS, url: "https://cdn/r1?fresh", expiresAt: expectedExpiresAt },
      ]);
    });

    test("skips records whose S3 object has already aged out", async () => {
      const live = { reportId: "LIVE", key: "reports/media-kit/LIVE.html", generatedAt: "2026-05-20T10:00:00.000Z", dataAsOf: "2026-05-20" };
      const stale = { reportId: "STALE", key: "reports/media-kit/STALE.html", generatedAt: "2025-01-01T10:00:00.000Z", dataAsOf: "2025-01-01" };
      listMediaKitRecords.mockResolvedValue([live, stale]);
      reportObjectExpiresAtMs.mockImplementation((r) =>
        r.reportId === "LIVE" ? Date.now() + 30 * 24 * 60 * 60 * 1000 : Date.now() - 1000,
      );
      signReportUrl.mockReturnValue({ url: "https://cdn/live?fresh", expiresAt: "ignored" });

      const res = await getKits({});

      expect(signReportUrl).toHaveBeenCalledTimes(1);
      expect(JSON.parse(res.body).media_kits.map((k) => k.reportId)).toEqual(["LIVE"]);
    });

    test("returns an empty list when there are no media kits", async () => {
      listMediaKitRecords.mockResolvedValue([]);
      const res = await getKits({});
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ media_kits: [] });
      expect(signReportUrl).not.toHaveBeenCalled();
    });
  });
});
