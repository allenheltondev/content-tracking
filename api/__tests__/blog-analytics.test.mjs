import { jest } from "@jest/globals";

process.env.ENVIRONMENT = "staging";

jest.unstable_mockModule("../domain/profile.mjs", () => ({ getProfileSettings: jest.fn() }));
jest.unstable_mockModule("../services/ga-secrets.mjs", () => ({ readGa4ServiceAccount: jest.fn() }));
jest.unstable_mockModule("../services/google-analytics.mjs", () => ({ fetchPageMetrics: jest.fn() }));

const { getProfileSettings } = await import("../domain/profile.mjs");
const { readGa4ServiceAccount } = await import("../services/ga-secrets.mjs");
const { fetchPageMetrics } = await import("../services/google-analytics.mjs");
const { getCanonicalViews } = await import("../services/blog-analytics.mjs");

beforeEach(() => {
  jest.clearAllMocks();
  getProfileSettings.mockResolvedValue({ ga4PropertyId: "363019578" });
  readGa4ServiceAccount.mockResolvedValue({ client_email: "x@y.iam" });
  fetchPageMetrics.mockResolvedValue({ totals: { pageviews: 1234 } });
});

test("returns 0 without a pagePath (no GA call)", async () => {
  expect(await getCanonicalViews({ pagePath: undefined })).toBe(0);
  expect(fetchPageMetrics).not.toHaveBeenCalled();
});

test("returns 0 when GA is not configured", async () => {
  getProfileSettings.mockResolvedValue({}); // no ga4PropertyId
  expect(await getCanonicalViews({ pagePath: "/blog/x" })).toBe(0);
  expect(fetchPageMetrics).not.toHaveBeenCalled();
});

test("returns total pageviews for the page path", async () => {
  const views = await getCanonicalViews({ pagePath: "/blog/x" });
  expect(views).toBe(1234);
  expect(fetchPageMetrics).toHaveBeenCalledWith(expect.objectContaining({
    serviceAccount: { client_email: "x@y.iam" },
    propertyId: "363019578",
    pagePath: "/blog/x",
  }));
});

test("propagates a GA fetch error (so the weekly job can record/retry)", async () => {
  fetchPageMetrics.mockRejectedValue(new Error("GA4 report failed"));
  await expect(getCanonicalViews({ pagePath: "/blog/x" })).rejects.toThrow(/GA4 report failed/);
});
