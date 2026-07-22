import { logger } from "./logger.mjs";
import { getProfileSettings } from "../domain/profile.mjs";
import { readGa4ServiceAccount } from "./ga-secrets.mjs";
import { fetchPageMetrics } from "./google-analytics.mjs";

// Shared GA4 core: config resolution and the section-shaped page-metrics
// loader. Every GA4 consumer (campaign web analytics, campaign report
// snapshots, canonical blog views) goes through here instead of each
// re-implementing the settings + service-account + propertyId dance.

export const DEFAULT_RANGE_DAYS = 28;

export function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

// Trailing 28-day window ending today — the default for every GA4 read
// that doesn't get an explicit range.
export function defaultGa4Range() {
  const end = new Date();
  const start = new Date(end.getTime() - (DEFAULT_RANGE_DAYS - 1) * 86400000);
  return { startDate: toIsoDate(start), endDate: toIsoDate(end) };
}

// Resolves the tenant's GA4 config (profile propertyId + service-account
// secret). Returns null when either half is missing — callers decide what
// "not configured" means for their shape.
export async function resolveGa4Config() {
  const [settings, serviceAccount] = await Promise.all([
    getProfileSettings(),
    readGa4ServiceAccount(),
  ]);
  const propertyId = settings?.ga4PropertyId;
  if (!propertyId || !serviceAccount) return null;
  return { propertyId, serviceAccount };
}

// Pulls per-page traffic as a structured section. Always resolves —
// missing config and upstream failures become `configured`/`error`
// fields rather than throwing, so partial-failure endpoints can report
// the section inline.
export async function loadGa4Section({ pagePath, startDate, endDate }) {
  const config = await resolveGa4Config();
  if (!config) {
    return { configured: false, error: null };
  }
  try {
    const report = await fetchPageMetrics({
      serviceAccount: config.serviceAccount,
      propertyId: config.propertyId,
      pagePath,
      startDate,
      endDate,
    });
    return { configured: true, error: null, ...report };
  } catch (err) {
    logger.warn("GA4 fetch failed", { error: err?.message });
    return { configured: true, error: err?.message ?? "unknown" };
  }
}
