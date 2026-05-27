import { logger } from "./logger.mjs";
import { UpstreamError } from "./errors.mjs";

// Core Web Vitals for a single blog URL. Primary source is the CrUX API
// (real-user p75 field data), which only returns a record for URLs with
// enough Chrome traffic — a 404 means "not enough data", which is common
// for new or low-traffic posts. When that happens we fall back to
// PageSpeed Insights, which runs a synthetic Lighthouse pass and works for
// any URL (lab data, not field data).
//
// Both take the same API key (a standard Google API key, distinct from the
// GA4 service account). The key is passed in by the caller (loaded from
// SSM in the route) so this module stays a pure HTTP client.

const CRUX_URL = "https://chromeuxreport.googleapis.com/v1/records:queryRecord";
const PSI_URL = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

export async function fetchWebVitals({ url, apiKey }) {
  const crux = await fetchCrux(url, apiKey);
  if (crux) return crux;
  logger.info("CrUX returned no field data; falling back to PageSpeed Insights", { url });
  return fetchPsi(url, apiKey);
}

async function fetchCrux(url, apiKey) {
  const response = await fetch(`${CRUX_URL}?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  });
  const text = await response.text();

  // 404 = no field data for this URL. Signal the caller to fall back.
  if (response.status === 404) return null;
  if (!response.ok) {
    logger.error("CrUX query failed", { url, status: response.status, body: text });
    throw new UpstreamError(`CrUX query failed: ${text}`, response.status);
  }

  const json = JSON.parse(text);
  const metrics = json.record?.metrics ?? {};
  const p75 = (key) => numOrNull(metrics[key]?.percentiles?.p75);

  return {
    source: "crux",
    url: json.record?.key?.url ?? url,
    collection_period: json.record?.collectionPeriod ?? null,
    metrics: {
      lcp_ms: p75("largest_contentful_paint"),
      cls: p75("cumulative_layout_shift"),
      inp_ms: p75("interaction_to_next_paint"),
      fcp_ms: p75("first_contentful_paint"),
      ttfb_ms: p75("experimental_time_to_first_byte"),
    },
  };
}

async function fetchPsi(url, apiKey) {
  const params = new URLSearchParams({
    url,
    key: apiKey,
    strategy: "mobile",
    category: "performance",
  });
  const response = await fetch(`${PSI_URL}?${params}`, { method: "GET" });
  const text = await response.text();
  if (!response.ok) {
    logger.error("PageSpeed Insights query failed", { url, status: response.status, body: text });
    throw new UpstreamError(`PageSpeed Insights query failed: ${text}`, response.status);
  }

  const json = JSON.parse(text);
  const lighthouse = json.lighthouseResult ?? {};
  const audits = lighthouse.audits ?? {};
  const ms = (key) => {
    const v = audits[key]?.numericValue;
    return typeof v === "number" ? Math.round(v) : null;
  };

  return {
    source: "psi",
    url: lighthouse.finalUrl ?? url,
    strategy: "mobile",
    performance_score: lighthouse.categories?.performance?.score ?? null,
    metrics: {
      // INP is a field-only metric; Lighthouse lab runs can't produce it.
      lcp_ms: ms("largest-contentful-paint"),
      cls: numOrNull(audits["cumulative-layout-shift"]?.numericValue),
      inp_ms: null,
      fcp_ms: ms("first-contentful-paint"),
      tbt_ms: ms("total-blocking-time"),
    },
  };
}

function numOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
