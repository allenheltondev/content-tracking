// Whether each cross-post platform can actually publish for a tenant, and if
// not, what's missing. Pure: it takes the tenant config row and the decrypted
// credentials blob and never touches AWS, so the settings endpoint and any
// future caller agree on one definition of "set up".
//
// The requirements mirror what each adapter refuses to publish without
// (api/services/blog-platforms/*.mjs). A token alone is NOT enough for Medium
// or Hashnode: both post into a publication, and their adapters throw on a
// missing publicationId. Reporting "configured" off the token would send the
// author to a cross-post that fails with a message they can't act on.
//
// The report carries booleans and the non-secret ids only. The token itself
// never leaves the server — `token_configured` is all the UI gets.

// `requires` is what the adapter throws without. Keys match the snake_case
// field names the settings endpoint accepts, so the UI can name the exact
// field to fill in.
export const CROSSPOST_REQUIREMENTS = {
  dev: { requires: ["token"] },
  medium: { requires: ["token", "publication_id"] },
  hashnode: { requires: ["token", "publication_id"] },
};

export const CROSSPOST_PLATFORM_KEYS = Object.keys(CROSSPOST_REQUIREMENTS);

function hasValue(value) {
  return typeof value === "string" ? value.trim().length > 0 : value !== null && value !== undefined;
}

// Returns { platforms: { dev: {...}, medium: {...}, hashnode: {...} } } in the
// API's snake_case shape. `tenant` and `credentials` may each be null (a fresh
// tenant has neither), which reports every platform as not ready.
export function describeCrosspostReadiness(tenant, credentials) {
  const configs = tenant?.platforms ?? {};
  const platforms = {};

  for (const [platform, { requires }] of Object.entries(CROSSPOST_REQUIREMENTS)) {
    const config = configs[platform] ?? {};
    const present = {
      token: hasValue(credentials?.[platform]),
      publication_id: hasValue(config.publicationId),
    };
    const missing = requires.filter((field) => !present[field]);

    const entry = {
      ready: missing.length === 0,
      token_configured: present.token,
      missing,
    };
    if (platform === "dev") {
      entry.organization_id = config.organizationId ?? null;
    }
    if (platform === "medium" || platform === "hashnode") {
      entry.publication_id = config.publicationId ?? null;
    }
    if (platform === "hashnode") {
      entry.blog_url = config.blogUrl ?? null;
    }
    platforms[platform] = entry;
  }

  return { platforms };
}
