import { getProfileSettings } from "../domain/profile.mjs";
import { readGa4ServiceAccount } from "./ga-secrets.mjs";
import { fetchPageMetrics } from "./google-analytics.mjs";

// Canonical-site (Google Analytics) all-time views for a blog post. Reuses
// the existing GA4 plumbing (profile ga4PropertyId + the GA4 service
// account secret + fetchPageMetrics), mirroring campaign-ga4.mjs.
//
// Returns 0 when GA isn't configured (nothing to read) or there's no
// pagePath. Throws on a GA fetch error so the weekly job can record/retry
// that source independently.

const ANALYTICS_START_DATE = "2015-01-01"; // well before any post → all-time

function today() {
  return new Date().toISOString().slice(0, 10);
}

export async function getCanonicalViews({ pagePath, startDate = ANALYTICS_START_DATE, endDate } = {}) {
  if (!pagePath) return 0;

  const [settings, serviceAccount] = await Promise.all([
    getProfileSettings(),
    readGa4ServiceAccount(),
  ]);

  const propertyId = settings?.ga4PropertyId;
  if (!propertyId || !serviceAccount) return 0;

  const report = await fetchPageMetrics({
    serviceAccount,
    propertyId,
    pagePath,
    startDate,
    endDate: endDate ?? today(),
  });

  return report?.totals?.pageviews ?? 0;
}
