import { jest } from "@jest/globals";
import { generateKeyPairSync } from "node:crypto";
import { fetchPageMetrics } from "../services/google-analytics.mjs";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

// Unique client_email per test keeps the module-level access-token cache
// from leaking across cases (the cache is keyed by client_email).
let emailCounter = 0;
function serviceAccount() {
  emailCounter += 1;
  return {
    client_email: `booked-${emailCounter}@example.iam.gserviceaccount.com`,
    private_key: privateKey,
  };
}

function fakeResponse({ ok = true, status = 200, body = {} }) {
  return { ok, status, text: async () => JSON.stringify(body) };
}

const TOKEN_BODY = { access_token: "ya29.token", expires_in: 3600 };

const REPORT_BODY = {
  metricHeaders: [
    { name: "screenPageViews" },
    { name: "totalUsers" },
    { name: "sessions" },
    { name: "averageSessionDuration" },
    { name: "engagementRate" },
    { name: "bounceRate" },
  ],
  rows: [
    {
      dimensionValues: [{ value: "20260501" }],
      metricValues: [{ value: "10" }, { value: "8" }, { value: "9" }, { value: "55.5" }, { value: "0.7" }, { value: "0.3" }],
    },
    {
      dimensionValues: [{ value: "20260502" }],
      metricValues: [{ value: "20" }, { value: "15" }, { value: "18" }, { value: "60" }, { value: "0.8" }, { value: "0.2" }],
    },
  ],
  totals: [
    {
      metricValues: [{ value: "30" }, { value: "21" }, { value: "27" }, { value: "58.25" }, { value: "0.75" }, { value: "0.25" }],
    },
  ],
};

afterEach(() => {
  delete global.fetch;
});

describe("fetchPageMetrics", () => {
  test("exchanges a JWT for a token then aggregates the report", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(fakeResponse({ body: TOKEN_BODY }))
      .mockResolvedValueOnce(fakeResponse({ body: REPORT_BODY }));

    const result = await fetchPageMetrics({
      serviceAccount: serviceAccount(),
      propertyId: "123456789",
      pagePath: "/my-post",
      startDate: "2026-05-01",
      endDate: "2026-05-02",
    });

    // First call is the OAuth token exchange, second is runReport.
    expect(global.fetch).toHaveBeenCalledTimes(2);
    const [tokenUrl] = global.fetch.mock.calls[0];
    expect(tokenUrl).toContain("oauth2.googleapis.com/token");
    const [reportUrl, reportInit] = global.fetch.mock.calls[1];
    expect(reportUrl).toContain("properties/123456789:runReport");
    expect(reportInit.headers.authorization).toBe("Bearer ya29.token");

    expect(result.property_id).toBe("123456789");
    expect(result.page_path).toBe("/my-post");
    expect(result.totals).toEqual({
      pageviews: 30,
      users: 21,
      sessions: 27,
      avg_session_duration: 58.25,
      engagement_rate: 0.75,
      bounce_rate: 0.25,
    });
    expect(result.by_day).toEqual({ "2026-05-01": 10, "2026-05-02": 20 });
  });

  test("sends an EXACT pagePath filter in the report body", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(fakeResponse({ body: TOKEN_BODY }))
      .mockResolvedValueOnce(fakeResponse({ body: REPORT_BODY }));

    await fetchPageMetrics({
      serviceAccount: serviceAccount(),
      propertyId: "1",
      pagePath: "/exact-path",
      startDate: "2026-05-01",
      endDate: "2026-05-02",
    });

    const reportInit = global.fetch.mock.calls[1][1];
    const sentBody = JSON.parse(reportInit.body);
    expect(sentBody.dimensionFilter.filter.stringFilter).toEqual({
      matchType: "EXACT",
      value: "/exact-path",
    });
  });
});
