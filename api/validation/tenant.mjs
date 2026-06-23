import { BadRequestError } from "../services/errors.mjs";

// Validation + formatting for the Tenant config entity. Request/response
// bodies are snake_case; internal storage is camelCase (matching the rest
// of the API, e.g. validation/vendor.mjs). Throws BadRequestError on any
// rule violation so route handlers can let it propagate to the error
// mapper.

const URL_MAX = 500;
const EMAIL_MAX = 320; // RFC 5321 maximum address length
const ID_MAX = 200;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const KNOWN_PLATFORMS = ["dev", "medium", "hashnode"];

function validateUrl(value, label) {
  if (typeof value !== "string" || value.length > URL_MAX) {
    throw new BadRequestError(`${label} must be a string up to ${URL_MAX} chars`);
  }
  if (!/^https?:\/\//i.test(value)) {
    throw new BadRequestError(`${label} must start with http:// or https://`);
  }
  return value;
}

// Platform id values (publication ids, org id) may arrive as strings or
// numbers (Dev.to's organization_id is numeric); normalize to string.
function validateId(value, label) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value !== "string" || value.trim().length === 0 || value.length > ID_MAX) {
    throw new BadRequestError(`${label} must be a non-empty string up to ${ID_MAX} chars`);
  }
  return value.trim();
}

function validatePlatforms(platforms) {
  if (typeof platforms !== "object" || platforms === null || Array.isArray(platforms)) {
    throw new BadRequestError("platforms must be a JSON object");
  }

  const out = {};
  for (const [platform, settings] of Object.entries(platforms)) {
    if (!KNOWN_PLATFORMS.includes(platform)) {
      throw new BadRequestError(`unknown platform "${platform}"`);
    }
    if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
      throw new BadRequestError(`platforms.${platform} must be a JSON object`);
    }

    const entry = {};
    if (platform === "dev" && settings.organization_id !== undefined) {
      entry.organizationId = validateId(settings.organization_id, "platforms.dev.organization_id");
    }
    if (platform === "medium" && settings.publication_id !== undefined) {
      entry.publicationId = validateId(settings.publication_id, "platforms.medium.publication_id");
    }
    if (platform === "hashnode") {
      if (settings.publication_id !== undefined) {
        entry.publicationId = validateId(settings.publication_id, "platforms.hashnode.publication_id");
      }
      if (settings.blog_url !== undefined) {
        entry.blogUrl = validateUrl(settings.blog_url, "platforms.hashnode.blog_url");
      }
    }
    if (Object.keys(entry).length > 0) {
      out[platform] = entry;
    }
  }
  return out;
}

export function validateTenantConfig(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequestError("request body must be a JSON object");
  }

  const out = {};
  const { canonical_base_url, admin_email, platforms } = body;

  if (canonical_base_url !== undefined) {
    out.canonicalBaseUrl = canonical_base_url === null
      ? null
      : validateUrl(canonical_base_url, "canonical_base_url");
  }

  if (admin_email !== undefined) {
    if (admin_email === null) {
      out.adminEmail = null;
    } else {
      if (typeof admin_email !== "string" || admin_email.length > EMAIL_MAX || !EMAIL_RE.test(admin_email)) {
        throw new BadRequestError("admin_email must look like an email address");
      }
      out.adminEmail = admin_email;
    }
  }

  if (platforms !== undefined) {
    out.platforms = validatePlatforms(platforms);
  }

  if (Object.keys(out).length === 0) {
    throw new BadRequestError("request body must contain at least one of canonical_base_url, admin_email, platforms");
  }

  return out;
}

export function formatTenant(row) {
  if (!row) {
    return {
      configured: false,
      canonical_base_url: null,
      admin_email: null,
      platforms: {
        dev: { organization_id: null },
        medium: { publication_id: null },
        hashnode: { publication_id: null, blog_url: null },
      },
    };
  }

  const platforms = row.platforms ?? {};
  return {
    configured: true,
    canonical_base_url: row.canonicalBaseUrl ?? null,
    admin_email: row.adminEmail ?? null,
    platforms: {
      dev: { organization_id: platforms.dev?.organizationId ?? null },
      medium: { publication_id: platforms.medium?.publicationId ?? null },
      hashnode: {
        publication_id: platforms.hashnode?.publicationId ?? null,
        blog_url: platforms.hashnode?.blogUrl ?? null,
      },
    },
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}
