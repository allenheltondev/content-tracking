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
  extractCampaignReportSnapshot: jest.fn(),
}));
jest.unstable_mockModule("../services/campaign-report-store.mjs", () => ({
  putCampaignReportHtml: jest.fn(),
  getCampaignReportHtml: jest.fn(),
  replaceCampaignReportHtml: jest.fn(),
}));
jest.unstable_mockModule("../services/report-signing.mjs", () => ({
  signReportUrl: jest.fn(),
  SIGNED_URL_TTL_SECONDS: 7 * 24 * 60 * 60,
}));
jest.unstable_mockModule("../domain/campaign-report-record.mjs", () => ({
  saveCampaignReportRecord: jest.fn(),
  listCampaignReportRecords: jest.fn(),
  findNewestCampaignReportRecord: jest.fn(),
  markCampaignReportSuperseded: jest.fn(),
}));
const LATEST_URL = "https://api.example.com/public/campaign-reports/TOKEN";
jest.unstable_mockModule("../domain/campaign-report-link.mjs", () => ({
  ensureCampaignReportLinkToken: jest.fn(),
  getCampaignReportLinkToken: jest.fn(),
  resolveCampaignReportLinkToken: jest.fn(),
  publicReportLinkUrl: jest.fn(),
}));
jest.unstable_mockModule("../domain/vendor-report-record.mjs", () => ({
  reportObjectExpiresAtMs: jest.fn(),
  REPORT_RETENTION_DAYS: 90,
}));
jest.unstable_mockModule("../services/newsletter-service.mjs", () => ({
  mintShortLink: jest.fn(),
}));
// The route now resolves the caller's tenant and verifies campaign ownership
// before doing any work. Mock the ownership guard so the report logic is still
// exercised in isolation; identity.requireTenantId runs for real off the
// synthetic requestContext.authorizer below.
jest.unstable_mockModule("../domain/campaign.mjs", () => ({
  assertCampaignOwned: jest.fn().mockResolvedValue({}),
}));

const { buildCampaignReportSnapshot } = await import("../domain/campaign-report.mjs");
const { renderCampaignReportHtml, extractCampaignReportSnapshot } = await import(
  "../services/campaign-report-renderer.mjs"
);
const { putCampaignReportHtml, getCampaignReportHtml, replaceCampaignReportHtml } = await import(
  "../services/campaign-report-store.mjs"
);
const { signReportUrl } = await import("../services/report-signing.mjs");
const {
  saveCampaignReportRecord,
  listCampaignReportRecords,
  findNewestCampaignReportRecord,
  markCampaignReportSuperseded,
} = await import("../domain/campaign-report-record.mjs");
const {
  ensureCampaignReportLinkToken,
  getCampaignReportLinkToken,
  resolveCampaignReportLinkToken,
  publicReportLinkUrl,
} = await import("../domain/campaign-report-link.mjs");
const { reportObjectExpiresAtMs } = await import("../domain/vendor-report-record.mjs");
const { mintShortLink } = await import("../services/newsletter-service.mjs");
const { assertCampaignOwned } = await import("../domain/campaign.mjs");
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
const getPublicReport = routes["GET /public/campaign-reports/:token"];

const CAMPAIGN_ID = "01HV0AABBCCDDEEFFGGHHJJKKM";

// requireTenantId reads the tenant off the Lambda authorizer context; every
// synthetic event carries a signed-in dashboard caller.
const AUTH_CTX = { requestContext: { authorizer: { authSource: "cognito", sub: "user-1" } } };

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
    ensureCampaignReportLinkToken.mockResolvedValue("TOKEN");
    getCampaignReportLinkToken.mockResolvedValue("TOKEN");
    publicReportLinkUrl.mockImplementation((_event, token) => (token ? LATEST_URL : null));
    // POST lists prior reports to supersede; default to none.
    listCampaignReportRecords.mockResolvedValue([]);
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

      const res = await postReport({ event: { ...AUTH_CTX, body: null }, params: { campaignId: CAMPAIGN_ID } });

      // Ownership guard runs first, scoped to the caller's resolved tenant.
      expect(assertCampaignOwned).toHaveBeenCalledWith(CAMPAIGN_ID, "user-1");

      // reportId assigned onto the snapshot before render + persistence.
      expect(snapshot.report.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      // The stable sponsor link is stamped onto the snapshot for the footer.
      expect(ensureCampaignReportLinkToken).toHaveBeenCalledWith(CAMPAIGN_ID);
      expect(snapshot.report.latestUrl).toBe(LATEST_URL);
      expect(renderCampaignReportHtml).toHaveBeenCalledWith(snapshot);

      // HTML stored under the right campaign/report key with the generated id.
      const putArg = putCampaignReportHtml.mock.calls[0][0];
      expect(putArg.campaignId).toBe(CAMPAIGN_ID);
      expect(putArg.reportId).toBe(snapshot.report.id);
      expect(putArg.html).toBe("<html>report</html>");

      // URL signed for the stored key, for the full 90-day retention window.
      expect(signReportUrl).toHaveBeenCalledWith(
        `reports/campaigns/${CAMPAIGN_ID}/RID.html`,
        { expiresInSeconds: 90 * 24 * 60 * 60 },
      );

      // Shortlink minted to wrap the long CloudFront signed URL, lasting as
      // long as the report itself.
      expect(mintShortLink).toHaveBeenCalledWith({
        url: "https://cdn.example.com/reports/campaigns/c/RID.html?sig",
        src: "campaign-report",
        expiresInDays: 90,
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
        latestUrl: LATEST_URL,
        // generatedAt (2026-05-29T10:00Z) + 90-day retention window.
        expiresAt: "2026-08-27T10:00:00.000Z",
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

      const res = await postReport({ event: { ...AUTH_CTX, body: null }, params: { campaignId: CAMPAIGN_ID } });

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
        event: { ...AUTH_CTX, body: "{not json", queryStringParameters: { year: "2024" } },
        params: { campaignId: CAMPAIGN_ID },
      });

      expect(buildCampaignReportSnapshot).toHaveBeenCalledWith({ campaignId: CAMPAIGN_ID });
    });

    test("re-renders older, unflagged reports with a supersededBy banner", async () => {
      const snapshot = makeSnapshot();
      buildCampaignReportSnapshot.mockResolvedValue(snapshot);
      renderCampaignReportHtml.mockImplementation((snap) => "<html>" + snap.report.id + "</html>");
      putCampaignReportHtml.mockResolvedValue("k-new");
      signReportUrl.mockReturnValue({ url: "u", expiresAt: "e" });
      mintShortLink.mockResolvedValue({ short_url: "s" });
      saveCampaignReportRecord.mockResolvedValue({});

      // ULIDs sort by time, so these fixed ids all precede the freshly
      // generated one; "ZZZ..." stands in for a report created concurrently
      // after it.
      const older = { reportId: "00000000000000000000000OLD", key: "k-old", generatedAt: "2026-05-01T00:00:00.000Z" };
      const flagged = {
        reportId: "0000000000000000000000DONE", key: "k-done", generatedAt: "2026-04-01T00:00:00.000Z", supersededAt: "x",
      };
      const expired = { reportId: "0000000000000000000000GONE", key: "k-gone", generatedAt: "2025-01-01T00:00:00.000Z" };
      const newer = { reportId: "ZZZZZZZZZZZZZZZZZZZZZZZZZZ", key: "k-newer", generatedAt: "2026-05-29T10:00:01.000Z" };
      listCampaignReportRecords.mockImplementation(async () => [
        newer,
        { reportId: snapshot.report.id, key: "k-new", generatedAt: snapshot.report.generatedAt },
        older,
        flagged,
        expired,
      ]);
      reportObjectExpiresAtMs.mockImplementation((r) =>
        r.key === "k-gone" ? Date.now() - 1000 : Date.now() + 86400000);
      getCampaignReportHtml.mockResolvedValue("<html>old</html>");
      extractCampaignReportSnapshot.mockReturnValue({
        report: { id: "OLD", generatedAt: older.generatedAt },
      });

      const res = await postReport({ event: { ...AUTH_CTX, body: null }, params: { campaignId: CAMPAIGN_ID } });
      expect(res.statusCode).toBe(201);

      // Only the live, unflagged, older report is touched; the concurrently
      // created newer one is left alone.
      expect(getCampaignReportHtml).toHaveBeenCalledTimes(1);
      expect(getCampaignReportHtml).toHaveBeenCalledWith("k-old");
      const rerendered = renderCampaignReportHtml.mock.calls.at(-1)[0];
      expect(rerendered.report).toEqual({
        id: "OLD",
        generatedAt: older.generatedAt,
        latestUrl: LATEST_URL,
        supersededBy: { url: LATEST_URL, generatedAt: snapshot.report.generatedAt },
      });
      expect(replaceCampaignReportHtml).toHaveBeenCalledWith("k-old", "<html>OLD</html>");
      expect(markCampaignReportSuperseded).toHaveBeenCalledTimes(1);
      expect(markCampaignReportSuperseded).toHaveBeenCalledWith(
        CAMPAIGN_ID,
        older.reportId,
        snapshot.report.generatedAt,
      );
    });

    test("caps the number of rewrites per request", async () => {
      buildCampaignReportSnapshot.mockResolvedValue(makeSnapshot());
      renderCampaignReportHtml.mockReturnValue("<html></html>");
      putCampaignReportHtml.mockResolvedValue("k-new");
      signReportUrl.mockReturnValue({ url: "u", expiresAt: "e" });
      mintShortLink.mockResolvedValue({ short_url: "s" });
      saveCampaignReportRecord.mockResolvedValue({});
      listCampaignReportRecords.mockResolvedValue(
        Array.from({ length: 40 }, (_, i) => ({
          reportId: "0000000000000000000000" + String(i).padStart(4, "0"),
          key: "k-" + i,
        })),
      );
      getCampaignReportHtml.mockResolvedValue("<html>old</html>");
      extractCampaignReportSnapshot.mockReturnValue({ report: {} });

      await postReport({ event: { ...AUTH_CTX, body: null }, params: { campaignId: CAMPAIGN_ID } });

      expect(replaceCampaignReportHtml).toHaveBeenCalledTimes(25);
    });

    test("a failed supersede does not fail generation or flag the record", async () => {
      buildCampaignReportSnapshot.mockResolvedValue(makeSnapshot());
      renderCampaignReportHtml.mockReturnValue("<html></html>");
      putCampaignReportHtml.mockResolvedValue("k-new");
      signReportUrl.mockReturnValue({ url: "u", expiresAt: "e" });
      mintShortLink.mockResolvedValue({ short_url: "s" });
      saveCampaignReportRecord.mockResolvedValue({});
      listCampaignReportRecords.mockResolvedValue([
        { reportId: "00000000000000000000000OLD", key: "k-old", generatedAt: "2026-05-01T00:00:00.000Z" },
      ]);
      getCampaignReportHtml.mockRejectedValue(new Error("NoSuchKey"));

      const res = await postReport({ event: { ...AUTH_CTX, body: null }, params: { campaignId: CAMPAIGN_ID } });

      expect(res.statusCode).toBe(201);
      expect(replaceCampaignReportHtml).not.toHaveBeenCalled();
      expect(markCampaignReportSuperseded).not.toHaveBeenCalled();
    });

    test("400 on invalid campaignId", async () => {
      await expect(
        postReport({ event: { ...AUTH_CTX, body: null }, params: { campaignId: "bad id!" } }),
      ).rejects.toThrow(/campaignId must be/);
      expect(buildCampaignReportSnapshot).not.toHaveBeenCalled();
    });

    test("propagates NotFoundError from the snapshot builder", async () => {
      buildCampaignReportSnapshot.mockRejectedValue(new NotFoundError("Campaign", "ghost"));
      await expect(
        postReport({ event: { ...AUTH_CTX, body: null }, params: { campaignId: "ghost" } }),
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
      // Both objects expire at the same fixed point in the future, so the
      // re-signed link and the reported expiry track the object lifetime.
      const objectExpiryMs = Date.now() + 365 * 24 * 60 * 60 * 1000;
      reportObjectExpiresAtMs.mockReturnValue(objectExpiryMs);
      const expectedExpiresAt = new Date(objectExpiryMs).toISOString();
      signReportUrl
        .mockReturnValueOnce({ url: "https://cdn/r2?fresh", expiresAt: "ignored" })
        .mockReturnValueOnce({ url: "https://cdn/r1?fresh", expiresAt: "ignored" });

      const res = await getReports({ event: AUTH_CTX, params: { campaignId: CAMPAIGN_ID } });

      expect(listCampaignReportRecords).toHaveBeenCalledWith(CAMPAIGN_ID);
      expect(signReportUrl).toHaveBeenNthCalledWith(
        1,
        `reports/campaigns/${CAMPAIGN_ID}/R2.html`,
        expect.objectContaining({ expiresInSeconds: expect.any(Number) }),
      );
      expect(signReportUrl).toHaveBeenNthCalledWith(
        2,
        `reports/campaigns/${CAMPAIGN_ID}/R1.html`,
        expect.objectContaining({ expiresInSeconds: expect.any(Number) }),
      );

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.campaign_id).toBe(CAMPAIGN_ID);
      expect(body.latest_url).toBe(LATEST_URL);
      expect(body.reports).toEqual([
        {
          reportId: "R2",
          generatedAt: "2026-05-29T10:00:00.000Z",
          dataAsOf: "2026-05-29",
          url: "https://cdn/r2?fresh",
          expiresAt: expectedExpiresAt,
          superseded: false,
        },
        {
          reportId: "R1",
          generatedAt: "2026-04-01T10:00:00.000Z",
          dataAsOf: "2026-04-01",
          url: "https://cdn/r1?fresh",
          expiresAt: expectedExpiresAt,
          superseded: false,
        },
      ]);
    });

    test("skips records whose S3 object has already aged out", async () => {
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
      // Live object still has time left; stale object is already gone.
      reportObjectExpiresAtMs.mockImplementation((r) =>
        r.reportId === "LIVE" ? Date.now() + 30 * 24 * 60 * 60 * 1000 : Date.now() - 1000,
      );
      signReportUrl.mockReturnValue({ url: "https://cdn/live?fresh", expiresAt: "ignored" });

      const res = await getReports({ event: AUTH_CTX, params: { campaignId: CAMPAIGN_ID } });

      // Only the live report is returned, and we never sign the stale key.
      expect(signReportUrl).toHaveBeenCalledTimes(1);
      expect(signReportUrl).toHaveBeenCalledWith(
        `reports/campaigns/${CAMPAIGN_ID}/LIVE.html`,
        expect.objectContaining({ expiresInSeconds: expect.any(Number) }),
      );
      const body = JSON.parse(res.body);
      expect(body.reports.map((r) => r.reportId)).toEqual(["LIVE"]);
    });

    test("returns an empty list when the campaign has no reports", async () => {
      listCampaignReportRecords.mockResolvedValue([]);
      const res = await getReports({ event: AUTH_CTX, params: { campaignId: CAMPAIGN_ID } });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ campaign_id: CAMPAIGN_ID, latest_url: LATEST_URL, reports: [] });
      expect(signReportUrl).not.toHaveBeenCalled();
    });

    test("latest_url is null before any report has been generated", async () => {
      getCampaignReportLinkToken.mockResolvedValue(null);
      const res = await getReports({ event: AUTH_CTX, params: { campaignId: CAMPAIGN_ID } });
      expect(JSON.parse(res.body).latest_url).toBeNull();
    });

    test("400 on invalid campaignId", async () => {
      await expect(getReports({ event: AUTH_CTX, params: { campaignId: "bad id!" } })).rejects.toThrow(/campaignId must be/);
      expect(listCampaignReportRecords).not.toHaveBeenCalled();
    });
  });

  describe("GET /public/campaign-reports/:token", () => {
    test("redirects to a fresh signed URL for the newest retained report", async () => {
      resolveCampaignReportLinkToken.mockResolvedValue(CAMPAIGN_ID);
      findNewestCampaignReportRecord.mockResolvedValue(
        { reportId: "NEW", key: "k-new", generatedAt: "2026-05-29T00:00:00.000Z" },
      );
      signReportUrl.mockReturnValue({ url: "https://cdn/new?sig", expiresAt: "e" });

      // No authorizer context: this route is public.
      const res = await getPublicReport({ event: {}, params: { token: "TOKEN" } });

      expect(resolveCampaignReportLinkToken).toHaveBeenCalledWith("TOKEN");
      expect(signReportUrl).toHaveBeenCalledWith(
        "k-new",
        expect.objectContaining({ expiresInSeconds: expect.any(Number) }),
      );
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("https://cdn/new?sig");
      expect(res.headers["cache-control"]).toBe("no-store");
    });

    test("only accepts reports with more than a minute of retention left", async () => {
      resolveCampaignReportLinkToken.mockResolvedValue(CAMPAIGN_ID);
      findNewestCampaignReportRecord.mockResolvedValue(null);
      await getPublicReport({ event: {}, params: { token: "TOKEN" } });

      const predicate = findNewestCampaignReportRecord.mock.calls[0][1];
      reportObjectExpiresAtMs.mockReturnValueOnce(Date.now() - 1000);
      expect(predicate({ key: "gone" })).toBe(false);
      reportObjectExpiresAtMs.mockReturnValueOnce(Date.now() + 86400000);
      expect(predicate({ key: "live" })).toBe(true);
    });

    test("404 page for an unknown token", async () => {
      resolveCampaignReportLinkToken.mockResolvedValue(null);
      const res = await getPublicReport({ event: {}, params: { token: "nope" } });
      expect(res.statusCode).toBe(404);
      expect(res.headers["content-type"]).toMatch(/text\/html/);
      expect(res.body).toContain("no longer available");
      expect(findNewestCampaignReportRecord).not.toHaveBeenCalled();
    });

    test("410 page when every report has aged out", async () => {
      resolveCampaignReportLinkToken.mockResolvedValue(CAMPAIGN_ID);
      findNewestCampaignReportRecord.mockResolvedValue(null);
      const res = await getPublicReport({ event: {}, params: { token: "TOKEN" } });
      expect(res.statusCode).toBe(410);
      expect(signReportUrl).not.toHaveBeenCalled();
    });
  });
});
