import { fetchPageMetrics } from "./google-analytics.mjs";
import { resolveGa4Config, toIsoDate } from "./ga4.mjs";

// Canonical-site (Google Analytics) all-time views for a blog post, on
// the shared GA4 core (services/ga4.mjs).
//
// Returns 0 when GA isn't configured (nothing to read) or there's no
// pagePath. Throws on a GA fetch error so the weekly job can record/retry
// that source independently — which is why this does NOT use the
// never-throwing loadGa4Section.

const ANALYTICS_START_DATE = "2015-01-01"; // well before any post → all-time

export async function getCanonicalViews({ pagePath, startDate = ANALYTICS_START_DATE, endDate } = {}) {
  if (!pagePath) return 0;

  const config = await resolveGa4Config();
  if (!config) return 0;

  const report = await fetchPageMetrics({
    serviceAccount: config.serviceAccount,
    propertyId: config.propertyId,
    pagePath,
    startDate,
    endDate: endDate ?? toIsoDate(new Date()),
  });

  return report?.totals?.pageviews ?? 0;
}
