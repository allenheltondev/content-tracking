import { jest } from "@jest/globals";
import { fetchWebVitals } from "../services/core-web-vitals.mjs";
import { UpstreamError } from "../services/errors.mjs";

function fakeResponse({ ok = true, status = 200, body = {} }) {
  return {
    ok,
    status,
    text: async () => JSON.stringify(body),
  };
}

const CRUX_BODY = {
  record: {
    key: { url: "https://blog.example.com/post" },
    collectionPeriod: { firstDate: { year: 2026, month: 4, day: 1 } },
    metrics: {
      largest_contentful_paint: { percentiles: { p75: 2100 } },
      cumulative_layout_shift: { percentiles: { p75: "0.04" } },
      interaction_to_next_paint: { percentiles: { p75: 180 } },
      first_contentful_paint: { percentiles: { p75: 1400 } },
      experimental_time_to_first_byte: { percentiles: { p75: 600 } },
    },
  },
};

const PSI_BODY = {
  lighthouseResult: {
    finalUrl: "https://blog.example.com/post",
    categories: { performance: { score: 0.92 } },
    audits: {
      "largest-contentful-paint": { numericValue: 2450.7 },
      "cumulative-layout-shift": { numericValue: 0.02 },
      "first-contentful-paint": { numericValue: 1200.2 },
      "total-blocking-time": { numericValue: 130.9 },
    },
  },
};

afterEach(() => {
  delete global.fetch;
});

describe("fetchWebVitals", () => {
  test("returns CrUX p75 field data when available", async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(fakeResponse({ body: CRUX_BODY }));

    const result = await fetchWebVitals({ url: "https://blog.example.com/post", apiKey: "k" });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(result.source).toBe("crux");
    expect(result.metrics).toEqual({
      lcp_ms: 2100,
      cls: 0.04,
      inp_ms: 180,
      fcp_ms: 1400,
      ttfb_ms: 600,
    });
  });

  test("falls back to PageSpeed Insights when CrUX has no data (404)", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(fakeResponse({ ok: false, status: 404, body: { error: "no data" } }))
      .mockResolvedValueOnce(fakeResponse({ body: PSI_BODY }));

    const result = await fetchWebVitals({ url: "https://blog.example.com/post", apiKey: "k" });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(result.source).toBe("psi");
    expect(result.performance_score).toBe(0.92);
    expect(result.metrics.lcp_ms).toBe(2451);
    expect(result.metrics.cls).toBe(0.02);
    expect(result.metrics.inp_ms).toBeNull();
    expect(result.metrics.tbt_ms).toBe(131);
  });

  test("throws UpstreamError on a non-404 CrUX failure", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(fakeResponse({ ok: false, status: 429, body: { error: "rate limit" } }));

    await expect(fetchWebVitals({ url: "https://blog.example.com/post", apiKey: "k" }))
      .rejects.toBeInstanceOf(UpstreamError);
  });
});
