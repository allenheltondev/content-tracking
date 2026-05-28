// Runtime configuration for the extension. The API base URL is baked in
// at packaging time by scripts/build-extension-zip.mjs (which reads the
// dashboard's VITE_API_BASE_URL in CI), so the user never has to copy a
// URL anywhere. The only per-install value is the pairing token they
// generate from the dashboard's Settings → Extension page.

export const DEFAULTS = {
  // Booked REST API base URL. Set by the packaging step; falls back to
  // empty so a hand-packed zip without the injection fails loudly rather
  // than silently calling the wrong host.
  apiBaseUrl: "__BOOKED_API_BASE_URL__",
  // Booked dashboard base URL. Used by the popup to deep-link the user
  // back to Settings → Extension when they haven't paired yet. Same
  // packaging-time substitution as apiBaseUrl; empty in load-unpacked
  // dev builds, in which case the popup falls back to plain text.
  dashboardBaseUrl: "__BOOKED_DASHBOARD_URL__",
  // How often (minutes) to refresh the monitoring working set.
  feedRefreshMinutes: 15,
};

const CONFIG_KEY = "booked_config";

export async function getConfig() {
  const stored = await chrome.storage.local.get(CONFIG_KEY);
  return { ...DEFAULTS, ...(stored[CONFIG_KEY] || {}) };
}

// True when the extension knows where to call. False on a hand-packed
// zip that skipped the injection step.
export function isConfigured(cfg) {
  return Boolean(cfg.apiBaseUrl && !cfg.apiBaseUrl.startsWith("__"));
}
