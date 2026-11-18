// Active Hashnode sync. Hashnode has no per-post stats page to open in a
// background tab, so the worker asks Hashnode's GraphQL API for the tracked
// post directly. The extension holds host permission for *.hashnode.com, so
// the request is not subject to CORS. Hashnode answers read queries only for
// publications on a Pro plan; any other publication gets a FORBIDDEN error,
// and the post then syncs only through passive capture while the author has
// the Hashnode dashboard open.

import { adapters, HASHNODE_GQL_URL, HASHNODE_STATS_QUERY, hashnodeStatsTargets } from "./adapters.js";

export class HashnodeApiError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "HashnodeApiError";
    this.code = code ?? null;
  }
}

async function queryPost(fetchImpl, host, slug) {
  const res = await fetchImpl(HASHNODE_GQL_URL, {
    method: "POST",
    // Sends the user's Hashnode session cookies if Hashnode accepts them for
    // API reads. The query is read-only.
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: HASHNODE_STATS_QUERY, variables: { host, slug } }),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* handled below */
  }
  if (parsed?.errors?.length) {
    const first = parsed.errors[0];
    throw new HashnodeApiError(
      `Hashnode API: ${first?.message || "request failed"}`,
      first?.extensions?.code,
    );
  }
  if (!res.ok || !parsed) {
    throw new HashnodeApiError(`Hashnode API: HTTP ${res.status}`);
  }
  return parsed;
}

// Returns the metrics for the tracked post at `postUrl`, or null when
// Hashnode has no publication or post for that URL. Throws HashnodeApiError
// on an API error (FORBIDDEN for a publication without a Pro plan).
export async function fetchHashnodePostMetrics(postUrl, { fetchImpl = fetch } = {}) {
  const targets = hashnodeStatsTargets(postUrl);
  for (const { host, slug } of targets) {
    const parsed = await queryPost(fetchImpl, host, slug);
    if (!parsed?.data?.publication) continue; // host not a Hashnode publication; try the next form
    const row = adapters.hashnode.extract(parsed).find((r) => r.nativeId === slug);
    return row ? row.metrics : null;
  }
  return null;
}
