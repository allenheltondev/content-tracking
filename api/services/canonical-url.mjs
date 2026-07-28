import { getTenant } from "../domain/tenant.mjs";

// Canonical URLs are stored as the author wrote them: absolute when the piece
// lives on someone else's domain, site-RELATIVE ("/blog/my-post/") when it's a
// path on the tenant's own site. Storing the path is what makes moving domains
// a settings change (profile → blog.canonical_base_url) instead of a rewrite of
// every content row; the base is joined back on at read time, and anything
// handing the URL to the outside world (cross-post adapters, the dashboard's
// link) absolutizes first.

export function isRelativeCanonical(value) {
  // A single leading slash only: "//example.com" is protocol-relative, which
  // leaves the site, so it isn't a path on it.
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//");
}

// The usable absolute URL for a stored canonical, or null when there isn't one:
// a relative path with no configured base can't be resolved, and returning the
// bare path would render as a link into whatever origin the reader is on. The
// path itself is still surfaced separately (`canonical_path`), so nothing is
// hidden — it just isn't passed off as a URL.
export function absolutizeCanonical(value, baseUrl) {
  if (typeof value !== "string" || value.length === 0) return null;
  if (!isRelativeCanonical(value)) return value;
  if (typeof baseUrl !== "string" || baseUrl.length === 0) return null;
  return `${baseUrl.replace(/\/+$/, "")}${value}`;
}

// The tenant's canonical base, read only when something actually needs it — a
// row storing a relative path. Rows carrying an absolute canonical (everything
// written before relative storage) resolve without the lookup.
export async function canonicalBaseFor(tenantId, rows) {
  const list = Array.isArray(rows) ? rows : [rows];
  if (!list.some((row) => isRelativeCanonical(row?.canonicalUrl))) return null;
  const tenant = await getTenant(tenantId).catch(() => null);
  return tenant?.canonicalBaseUrl ?? null;
}
