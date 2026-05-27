// Cognito Hosted UI OAuth (Authorization code + PKCE) for a public client.
// The flow runs through chrome.identity.launchWebAuthFlow, which opens the
// hosted login and captures the redirect back to the extension's
// chromiumapp.org URL. Tokens land in chrome.storage.local; the id_token is
// what the Booked API authorizer expects (it validates `aud`, which only
// the id_token carries — the dashboard sends the id_token for the same
// reason).

import { getConfig, isConfigured } from "./config.js";

const TOKENS_KEY = "booked_tokens";
const REFRESH_SKEW_MS = 60_000; // refresh a minute before expiry

export function getRedirectUri() {
  return chrome.identity.getRedirectURL();
}

function base64UrlEncode(bytes) {
  let str = "";
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) str += String.fromCharCode(arr[i]);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(digest);
}

export function decodeJwt(token) {
  try {
    const payload = token.split(".")[1];
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(decodeURIComponent(escape(json)));
  } catch {
    return null;
  }
}

async function storeTokens({ id_token, access_token, refresh_token, expires_in }) {
  const current = (await chrome.storage.local.get(TOKENS_KEY))[TOKENS_KEY] || {};
  const tokens = {
    idToken: id_token,
    accessToken: access_token,
    // Cognito does not return a new refresh_token on refresh; keep the prior one.
    refreshToken: refresh_token || current.refreshToken,
    expiresAt: Date.now() + (Number(expires_in) || 3600) * 1000,
  };
  await chrome.storage.local.set({ [TOKENS_KEY]: tokens });
  return tokens;
}

async function loadTokens() {
  return (await chrome.storage.local.get(TOKENS_KEY))[TOKENS_KEY] || null;
}

export async function isSignedIn() {
  const tokens = await loadTokens();
  return Boolean(tokens?.refreshToken);
}

export async function getSession() {
  const tokens = await loadTokens();
  if (!tokens?.idToken) return null;
  const claims = decodeJwt(tokens.idToken);
  return { email: claims?.email || claims?.username || null };
}

export async function signOut() {
  await chrome.storage.local.remove(TOKENS_KEY);
}

async function exchangeCode(cfg, code, verifier) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: cfg.clientId,
    code,
    redirect_uri: getRedirectUri(),
    code_verifier: verifier,
  });
  return tokenRequest(cfg, body);
}

async function refreshTokens(cfg, refreshToken) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: cfg.clientId,
    refresh_token: refreshToken,
  });
  return tokenRequest(cfg, body);
}

async function tokenRequest(cfg, body) {
  const res = await fetch(`${cfg.cognitoDomain.replace(/\/$/, "")}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Token endpoint ${res.status}: ${text || res.statusText}`);
  }
  return res.json();
}

export async function signIn() {
  const cfg = await getConfig();
  if (!isConfigured(cfg)) {
    throw new Error("Extension is not configured. Open the options page first.");
  }

  const verifier = randomString(48);
  const challenge = await pkceChallenge(verifier);
  const state = randomString(16);

  const authUrl =
    `${cfg.cognitoDomain.replace(/\/$/, "")}/oauth2/authorize?` +
    new URLSearchParams({
      response_type: "code",
      client_id: cfg.clientId,
      redirect_uri: getRedirectUri(),
      scope: cfg.scopes || "openid",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();

  const redirect = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
  if (!redirect) throw new Error("Sign-in was cancelled.");

  const params = new URL(redirect).searchParams;
  if (params.get("error")) {
    throw new Error(`${params.get("error")}: ${params.get("error_description") || ""}`);
  }
  if (params.get("state") !== state) {
    throw new Error("OAuth state mismatch; aborting.");
  }
  const code = params.get("code");
  if (!code) throw new Error("No authorization code in redirect.");

  await storeTokens(await exchangeCode(cfg, code, verifier));
  return getSession();
}

// Returns a valid id_token, refreshing transparently when it's near expiry.
export async function getIdToken() {
  const tokens = await loadTokens();
  if (!tokens?.refreshToken) {
    throw new Error("Not signed in.");
  }
  if (tokens.idToken && tokens.expiresAt - Date.now() > REFRESH_SKEW_MS) {
    return tokens.idToken;
  }
  const cfg = await getConfig();
  const refreshed = await refreshTokens(cfg, tokens.refreshToken).catch(async (err) => {
    // A dead refresh token means the session is gone; clear it so the UI
    // prompts a fresh sign-in instead of looping.
    await signOut();
    throw err;
  });
  const stored = await storeTokens(refreshed);
  return stored.idToken;
}
