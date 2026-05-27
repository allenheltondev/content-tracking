import { getConfig, setConfig } from "./config.js";
import { getRedirectUri } from "./auth.js";

const FIELDS = ["apiBaseUrl", "cognitoDomain", "clientId", "region", "scopes", "feedRefreshMinutes"];
const statusEl = document.getElementById("status");

document.getElementById("redirect").textContent = getRedirectUri();

function originPattern(url) {
  try {
    return `${new URL(url).origin}/*`;
  } catch {
    return null;
  }
}

async function load() {
  const cfg = await getConfig();
  for (const field of FIELDS) {
    const el = document.getElementById(field);
    if (el) el.value = cfg[field] ?? "";
  }
}

document.getElementById("save").addEventListener("click", async () => {
  const values = {};
  for (const field of FIELDS) {
    values[field] = document.getElementById(field).value.trim();
  }
  values.feedRefreshMinutes = Math.max(1, Number(values.feedRefreshMinutes) || 15);

  // The extension fetches the Booked API and the Cognito token endpoint
  // cross-origin; with host permission for those origins the requests
  // bypass the API's CORS allow-list. Request them now so the user
  // approves once, here, rather than mid-flow.
  const origins = [originPattern(values.apiBaseUrl), originPattern(values.cognitoDomain)].filter(
    Boolean,
  );

  if (origins.length) {
    const granted = await chrome.permissions.request({ origins });
    if (!granted) {
      statusEl.textContent = "Host access denied — syncing won't work until granted.";
      statusEl.className = "error";
      return;
    }
  }

  await setConfig(values);
  statusEl.textContent = "Saved.";
  statusEl.className = "saved";
  setTimeout(() => {
    statusEl.textContent = "";
    statusEl.className = "muted";
  }, 2500);
});

load();
