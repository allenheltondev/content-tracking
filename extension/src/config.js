// Runtime configuration for the extension. Defaults are empty on purpose —
// every install talks to a different Booked deployment + Cognito pool, so
// the user fills these in on the options page and they're persisted to
// chrome.storage.local. Nothing here is a secret: the Cognito app client
// is public (PKCE, no client secret).

export const DEFAULTS = {
  // AWS region of the Cognito user pool, e.g. "us-east-1".
  region: "",
  // Full Cognito Hosted UI domain, e.g.
  // "https://your-domain.auth.us-east-1.amazoncognito.com".
  cognitoDomain: "",
  // The Cognito app client id (public client with the Authorization code
  // grant + the extension redirect URI enabled).
  clientId: "",
  // OAuth scopes. "openid" is required to receive an id_token.
  scopes: "openid email profile",
  // Booked API base URL — the stack's ContentTrackingApiBaseUrl output,
  // including the /v1 stage when using the execute-api hostname.
  apiBaseUrl: "",
  // How often (minutes) to refresh the active-campaign post feed.
  feedRefreshMinutes: 15,
};

const CONFIG_KEY = "booked_config";

export async function getConfig() {
  const stored = await chrome.storage.local.get(CONFIG_KEY);
  return { ...DEFAULTS, ...(stored[CONFIG_KEY] || {}) };
}

export async function setConfig(partial) {
  const next = { ...(await getConfig()), ...partial };
  await chrome.storage.local.set({ [CONFIG_KEY]: next });
  return next;
}

// True only when every value the auth + API flows need is present.
export function isConfigured(cfg) {
  return Boolean(cfg.cognitoDomain && cfg.clientId && cfg.apiBaseUrl);
}
