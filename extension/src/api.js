// Thin authenticated client for the Booked API. The extension is granted
// host permission for the API origin so these cross-origin fetches are
// not subject to the API's CORS allow-list. The pairing token goes in
// the Authorization header as `Bearer <token>` — the Lambda authorizer
// verifies the HMAC signature and checks revocation before forwarding
// the request to the API.

import { getConfig, isConfigured } from "./config.js";
import { getPairingToken } from "./pairing.js";

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function apiFetch(path, { method = "GET", body } = {}) {
  const cfg = await getConfig();
  if (!isConfigured(cfg)) {
    throw new ApiError(0, "Extension build is missing its API base URL.");
  }
  const token = await getPairingToken();
  if (!token) {
    throw new ApiError(0, "Not paired. Open the popup and paste a pairing code.");
  }
  const base = cfg.apiBaseUrl.replace(/\/$/, "");

  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const parsed = JSON.parse(text);
      if (parsed?.message) message = parsed.message;
    } catch {
      /* keep status text */
    }
    throw new ApiError(res.status, message);
  }
  return text.length ? JSON.parse(text) : null;
}

// Pulls the working set the extension scrapes against: every social post,
// every content post, and every cross-post link tied to a campaign in
// "monitoring" status. Returns all three so the worker can match captured
// engagement to a post (social or content) and surface cross-post links
// in the popup.
export async function getMonitoringWorkingSet() {
  const res = await apiFetch("/monitoring/working-set");
  return {
    socialPosts: res?.social_posts ?? [],
    contentPosts: res?.content_posts ?? [],
    crossPostLinks: res?.cross_post_links ?? [],
  };
}

// Used by the worker to write captured engagement back. Bucket selects
// the endpoint — social posts and content posts live under sibling
// resources on the API so sponsor reports can render the two
// independently.
export async function putAnalytics(bucket, campaignId, postId, metrics, capturedAt) {
  const resource = bucket === "content" ? "content-posts" : "social-posts";
  return apiFetch(`/campaigns/${campaignId}/${resource}/${postId}/analytics`, {
    method: "PUT",
    body: { metrics, capturedAt },
  });
}
