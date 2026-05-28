// Thin authenticated client for the Booked API. The extension is granted
// host permission for the API origin (requested on the options page), so
// these cross-origin fetches are not subject to the API's CORS allow-list.
// The id_token goes in the raw Authorization header — no "Bearer" prefix —
// matching the dashboard and the API's Cognito authorizer.

import { getConfig } from "./config.js";
import { getIdToken } from "./auth.js";

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function apiFetch(path, { method = "GET", body } = {}) {
  const cfg = await getConfig();
  const token = await getIdToken();
  const base = cfg.apiBaseUrl.replace(/\/$/, "");

  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: token,
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

// Pulls the working set the extension scrapes against: every social post
// and every cross-post link tied to a campaign in "monitoring" status.
// Returns both arrays so the worker can match captured engagement to a
// social post and surface cross-post links in the popup.
export async function getMonitoringWorkingSet() {
  const res = await apiFetch("/monitoring/working-set");
  return {
    socialPosts: res?.social_posts ?? [],
    crossPostLinks: res?.cross_post_links ?? [],
  };
}

export async function putAnalytics(campaignId, postId, metrics, capturedAt) {
  return apiFetch(`/campaigns/${campaignId}/social-posts/${postId}/analytics`, {
    method: "PUT",
    body: { metrics, capturedAt },
  });
}
