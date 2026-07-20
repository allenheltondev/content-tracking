import { randomUUID } from 'node:crypto';

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// A thin client for Booked's content + review API, authenticated with an API
// key (sent raw in the Authorization header, matching the stack's authorizer).
// `fetchImpl` is injectable for tests.
export function createClient({ apiUrl, apiKey, fetchImpl = fetch }) {
  const base = String(apiUrl).replace(/\/$/, '');

  async function call(method, path, body) {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        authorization: apiKey,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        // POST endpoints are idempotency-aware; a fresh key per call is fine.
        ...(method === 'POST' ? { 'idempotency-key': randomUUID() } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const parsed = text ? safeJson(text) : null;
    if (!res.ok) {
      const err = new Error(parsed?.message ?? `${res.status} ${res.statusText}`);
      err.status = res.status;
      throw err;
    }
    return parsed;
  }

  return {
    // Resolve a slug to its content record, or null when no post has it.
    async findBySlug(slug) {
      try {
        return await call('GET', `/content/by-slug/${encodeURIComponent(slug)}`);
      } catch (err) {
        if (err.status === 404) return null;
        throw err;
      }
    },
    createContent(fields) { return call('POST', '/content', fields); },
    updateContent(id, fields) { return call('PATCH', `/content/${id}`, fields); },
    startReview(id, platform) { return call('POST', `/content/${id}/reviews`, platform ? { platform } : undefined); },
    getReview(id, reviewId) { return call('GET', `/content/${id}/reviews/${reviewId}`); },
    getSuggestions(id) { return call('GET', `/content/${id}/suggestions`); },
  };
}
