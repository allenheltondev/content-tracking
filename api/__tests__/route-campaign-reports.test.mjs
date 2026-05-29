import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";
process.env.ENVIRONMENT = "staging";

// Mock every collaborator so the route logic is exercised in isolation:
// the campaign snapshot builder, the HTML renderer, the campaign S3 store,
// the campaign record persistence layer, and the REUSED generic signer +
// retention helper that live in the vendor modules.
jest.unstable_mockModule("../domain/campaign-report.mjs", () => ({
  buildCampaignReportSnapshot: jest.fn(),
}));
jest.unstable_mockModule("../services/campaign-report-renderer.mjs", () => ({
  renderCampaignReportHtml: jest.fn(),
}));
jest.unstable_mockModule("../services/campaign-report-store.mjs", () => ({
  putCampaignReportHtml: jest.fn(),
}));
jest.unstable_mockModule("../services/vendor-report-store.mjs", () => ({
  signReportUrl: jest.fn(),
  SIGNED_URL_TTL_SECONDS: 7 * 24 * 60 * 60,
}));
jest.unstable_mockModule("../domain/campaign-report-record.mjs", () => ({
  saveCampaignReportRecord: jest.fn(),
  listCampaignReportRecords: jest.fn(),
}));
jest.unstable_mockModule("../domain/vendor-report-record.mjs", () => ({
  reportObjectExpiresAtMs: jest.fn(),
}));
jest.unstable_mockModule("../services/newsletter-service.mjs", () => ({
  mintShortLink: jest.fn(),
}));

const { buildCampaignReportSnapshot } = await import("../domain/campaign-report.mjs");
const { renderCampaignReportHtml } = await import("../services/campaign-report-renderer.mjs");
const { putCampaignReportHtml } = await import("../services/campaign-report-store.mjs");
const { signReportUrl } = await import("../services/vendor-report-store.mjs");
const { saveCampaignReportRecord, listCampaignReportRecords } = await import(
  "../domain/campaign-report-record.mjs"
);
const { reportObjectExpiresAtMs } = await import("../domain/vendor-report-record.mjs");
const { mintShortLink } = await import("../services/newsletter-service.mjs");
const { NotFoundError } = await import("../services/errors.mjs");
const { registerCampaignReportRoutes } = await import("../routes/campaign-reports.mjs");

// Capture the handlers the route module registers so we can call them
// directly with synthetic { event, params } the way the Router would.
function buildRouteTable() {
  const routes = {};
  const app = {
    post: (path, handler) => { routes[`POST ${path}`] = handler; },
    get: (path, handler) => { routes[`GET ${path}`] = handler; },
  };
  registerCampaignReportRoutes(app);
  return routes;
}

const routes = buildRouteTable();
const postReport = routes["POST /campaigns/:campaignId/report"];
const getReports = routes["GET /campaigns/:campaignId/reports"];

const CAMPAIGN_ID = "01HV0AABBCCDDEEFFGGHHJJKKM";

function makeSnapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    report: {
      id: null,
      generatedAt: "2026-05-29T10:00:00.000Z",
      dataAsOf: "2026-05-29",
      kind: "campaign",
    },
    campaign: { id: CAMPAIGN_ID, name: "Launch" },
    summary: {
      totalClicks: 1200,
      linkCount: 4,
      firstClickAt: "2026-01-02T00:00:00.000Z",
      lastClickAt: "2026-05-28T00:00:00.000Z",
      upstreamFailures: 0,
    },
    bySrc: [],
    byDay: [],
    links: [],
    ...overrides,
  };
}

describe("routes/campaign-reports", () => {
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

  describe("POST /campaigns/:campaignId/report", () => {
    test("happy path: assigns reportId, stores html, signs url, saves record, returns 201", async () => {
      const snapshot = makeSnapshot();
      buildCampaignReportSnapshot.mockResolvedValue(snapshot);
      renderCampaignReportHtml.mockReturnValue("<html>report</html>");
      putCampaignReportHtml.mockResolvedValue(`reports/campaigns/${CAMPAIGN_ID}/RID.html`);
      signReportUrl.mockReturnValue({
        url: "https://cdn.example.com/reports/campaigns/c/RID.html?sig",
        expiresAt: "2026-06-05T10:00:00.000Z",
      });
      mintShortLink.mockResolvedValue({ short_url: "https://bkd.to/r1" });
      saveCampaignReportRecord.mockResolvedValue({});

      const res = await postReport({ event: { body: null }, params: { campaignId: CAMPAIGN_ID } });

      // reportId assigned onto the snapshot before render + persistence.
      expect(snapshot.report.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(renderCampaignReportHtml).toHaveBeenCalledWith(snapshot);

      // HTML stored under the right campaign/report key with the generated id.
      const putArg = putCampaignReportHtml.mock.calls[0][0];
      expect(putArg.campaignId).toBe(CAMPAIGN_ID);
      expect(putArg.reportId).toBe(snapshot.report.id);
      expect(putArg.html).toBe("<html>report</html>");

      // URL signed for the stored key.
      expect(signReportUrl).toHaveBeenCalledWith(`reports/campaigns/${CAMPAIGN_ID}/RID.html`);

      // Shortlink minted to wrap the long CloudFront signed URL.
      expect(mintShortLink).toHaveBeenCalledWith({
        url: "https://cdn.example.com/reports/campaigns/c/RID.html?sig",
        src: "campaign-report",
        expiresInDays: 7,
      });

      // Record persisted with metadata (not the body), and NO period.
      const recordArg = saveCampaignReportRecord.mock.calls[0][0];
      expect(recordArg).toMatchObject({
        campaignId: CAMPAIGN_ID,
        reportId: snapshot.report.id,
        key: `reports/campaigns/${CAMPAIGN_ID}/RID.html`,
        generatedAt: "2026-05-29T10:00:00.000Z",
        dataAsOf: "2026-05-29",
        summary: snapshot.summary,
      });
      expect(recordArg).not.toHaveProperty("period");

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body).toEqual({
        reportId: snapshot.report.id,
        url: "https://cdn.example.com/reports/campaigns/c/RID.html?sig",
        shortUrl: "https://bkd.to/r1",
        expiresAt: "2026-06-05T10:00:00.000Z",
        dataAsOf: "2026-05-29",
        summary: snapshot.summary,
      });
    });

    test("returns shortUrl: null when the shortlink mint fails", async () => {
      buildCampaignReportSnapshot.mockResolvedValue(makeSnapshot());
      renderCampaignReportHtml.mockReturnValue("<html></html>");
      putCampaignReportHtml.mockResolvedValue("k");
      signReportUrl.mockReturnValue({
        url: "https://cdn.example.com/r.html?sig",
        expiresAt: "2026-06-05T10:00:00.000Z",
      });
      mintShortLink.mockRejectedValue(new Error("upstream boom"));
      saveCampaignReportRecord.mockResolvedValue({});

      const res = await postReport({ event: { body: null }, params: { campaignId: CAMPAIGN_ID } });

      // Mint failure must not break report generation — the long URL still
      // works and the response simply reports shortUrl: null.
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.shortUrl).toBeNull();
      expect(body.url).toBe("https://cdn.example.com/r.html?sig");
      // Record was still persisted.
      expect(saveCampaignReportRecord).toHaveBeenCalled();
    });

    test("ignores the request body (no period parsing)", async () => {
      buildCampaignReportSnapshot.mockResolvedValue(makeSnapshot());
      renderCampaignReportHtml.mockReturnValue("<html></html>");
      putCampaignReportHtml.mockResolvedValue("k");
      signReportUrl.mockReturnValue({ url: "u", expiresAt: "e" });
      mintShortLink.mockResolvedValue({ short_url: "s" });
      saveCampaignReportRecord.mockResolvedValue({});

      // Even an unparseable body must not error — it is ignored entirely.
      await postReport({
        event: { body: "{not json", queryStringParameters: { year: "2024" } },
        params: { campaignId: CAMPAIGN_ID },
      });

      expect(buildCampaignReportSnapshot).toHaveBeenCalledWith({ campaignId: CAMPAIGN_ID });
    });

    test("400 on invalid campaignId", async () => {
      await expect(
        postReport({ event: { body: null }, params: { campaignId: "bad id!" } }),
      ).rejects.toThrow(/campaignId must be/);
      expect(buildCampaignReportSnapshot).not.toHaveBeenCalled();
    });

    test("propagates NotFoundError from the snapshot builder", async () => {
      buildCampaignReportSnapshot.mockRejectedValue(new NotFoundError("Campaign", "ghost"));
      await expect(
        postReport({ event: { body: null }, params: { campaignId: "ghost" } }),
      ).rejects.toThrow(/Campaign ghost not found/);
      expect(putCampaignReportHtml).not.toHaveBeenCalled();
      expect(saveCampaignReportRecord).not.toHaveBeenCalled();
    });
  });

  describe("GET /campaigns/:campaignId/reports", () => {
    test("re-signs a fresh URL for each stored record, newest first", async () => {
      listCampaignReportRecords.mockResolvedValue([
        {
          reportId: "R2",
          key: `reports/campaigns/${CAMPAIGN_ID}/R2.html`,
          generatedAt: "2026-05-29T10:00:00.000Z",
          dataAsOf: "2026-05-29",
        },
        {
          reportId: "R1",
          key: `reports/campaigns/${CAMPAIGN_ID}/R1.html`,
          generatedAt: "2026-04-01T10:00:00.000Z",
          dataAsOf: "2026-04-01",
        },
      ]);
      signReportUrl
        .mockReturnValueOnce({ url: "https://cdn/r2?fresh", expiresAt: "2026-06-05T10:00:00.000Z" })
        .mockReturnValueOnce({ url: "https://cdn/r1?fresh", expiresAt: "2026-06-05T10:00:00.000Z" });

      const res = await getReports({ params: { campaignId: CAMPAIGN_ID } });

      expect(listCampaignReportRecords).toHaveBeenCalledWith(CAMPAIGN_ID);
      expect(signReportUrl).toHaveBeenNthCalledWith(1, `reports/campaigns/${CAMPAIGN_ID}/R2.html`);
      expect(signReportUrl).toHaveBeenNthCalledWith(2, `reports/campaigns/${CAMPAIGN_ID}/R1.html`);

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.campaign_id).toBe(CAMPAIGN_ID);
      expect(body.reports).toEqual([
        {
          reportId: "R2",
          generatedAt: "2026-05-29T10:00:00.000Z",
          dataAsOf: "2026-05-29",
          url: "https://cdn/r2?fresh",
          expiresAt: "2026-06-05T10:00:00.000Z",
        },
        {
          reportId: "R1",
          generatedAt: "2026-04-01T10:00:00.000Z",
          dataAsOf: "2026-04-01",
          url: "https://cdn/r1?fresh",
          expiresAt: "2026-06-05T10:00:00.000Z",
        },
      ]);
    });

    test("skips records whose S3 object would expire before the fresh link", async () => {
      const live = {
        reportId: "LIVE",
        key: `reports/campaigns/${CAMPAIGN_ID}/LIVE.html`,
        generatedAt: "2026-05-20T10:00:00.000Z",
        dataAsOf: "2026-05-20",
      };
      const stale = {
        reportId: "STALE",
        key: `reports/campaigns/${CAMPAIGN_ID}/STALE.html`,
        generatedAt: "2025-01-01T10:00:00.000Z",
        dataAsOf: "2025-01-01",
      };
      listCampaignReportRecords.mockResolvedValue([live, stale]);
      // Live object outlives the link; stale object is already gone.
      reportObjectExpiresAtMs.mockImplementation((r) =>
        r.reportId === "LIVE" ? Date.now() + 30 * 24 * 60 * 60 * 1000 : Date.now() - 1000,
      );
      signReportUrl.mockReturnValue({ url: "https://cdn/live?fresh", expiresAt: "2026-06-05T10:00:00.000Z" });

      const res = await getReports({ params: { campaignId: CAMPAIGN_ID } });

      // Only the live report is returned, and we never sign the stale key.
      expect(signReportUrl).toHaveBeenCalledTimes(1);
      expect(signReportUrl).toHaveBeenCalledWith(`reports/campaigns/${CAMPAIGN_ID}/LIVE.html`);
      const body = JSON.parse(res.body);
      expect(body.reports.map((r) => r.reportId)).toEqual(["LIVE"]);
    });

    test("returns an empty list when the campaign has no reports", async () => {
      listCampaignReportRecords.mockResolvedValue([]);
      const res = await getReports({ params: { campaignId: CAMPAIGN_ID } });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ campaign_id: CAMPAIGN_ID, reports: [] });
      expect(signReportUrl).not.toHaveBeenCalled();
    });

    test("400 on invalid campaignId", async () => {
      await expect(getReports({ params: { campaignId: "bad id!" } })).rejects.toThrow(/campaignId must be/);
      expect(listCampaignReportRecords).not.toHaveBeenCalled();
    });
  });
});
