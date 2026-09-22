import { BadRequestError } from "../services/errors.mjs";
import { CROSSPOST_PLATFORM_KEYS } from "../services/crosspost-readiness.mjs";

// Body for PUT /settings/crosspost. One entry per platform, each optional:
//
//   {
//     "platforms": {
//       "dev":      { "token": "…", "organization_id": "123" },
//       "medium":   { "token": "…", "publication_id": "abc" },
//       "hashnode": { "token": "…", "publication_id": "…", "blog_url": "https://…" }
//     }
//   }
//
// For every field: a value sets it, null clears it, and leaving it out leaves
// it alone. That three-way split is what lets the settings page save one card
// without touching the others, and lets "Disconnect" clear a token without
// also wiping the publication id the author will want back when they reconnect.
//
// The result is split by where each field lives — tokens go to the SSM
// SecureString, ids to the tenant config row — so the route never has to
// know which is which.

const TOKEN_MAX = 1000;
const ID_MAX = 200;
const URL_MAX = 500;

// Which non-secret fields each platform accepts, snake_case -> tenant camelCase.
const CONFIG_FIELDS = {
  dev: { organization_id: "organizationId" },
  medium: { publication_id: "publicationId" },
  hashnode: { publication_id: "publicationId", blog_url: "blogUrl" },
};

function validateToken(value, label) {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new BadRequestError(`${label} must be a string or null`);
  }
  const trimmed = value.trim();
  // An empty string is almost always a blank input submitted by accident. Treat
  // it as a mistake rather than a clear: clearing a credential should be a
  // deliberate null, never a side effect of saving an untouched field.
  if (trimmed.length === 0 || trimmed.length > TOKEN_MAX) {
    throw new BadRequestError(`${label} must be a non-empty string up to ${TOKEN_MAX} chars, or null to clear it`);
  }
  return trimmed;
}

function validateConfigValue(value, field, label) {
  if (value === null) return null;
  if (field === "blog_url") {
    if (typeof value !== "string" || value.length > URL_MAX || !/^https?:\/\//i.test(value.trim())) {
      throw new BadRequestError(`${label} must be an http(s) URL up to ${URL_MAX} chars, or null`);
    }
    return value.trim();
  }
  // Dev.to's organization id is numeric; accept either and store a string.
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string" || value.trim().length === 0 || value.length > ID_MAX) {
    throw new BadRequestError(`${label} must be a non-empty string up to ${ID_MAX} chars, or null`);
  }
  return value.trim();
}

export function validateCrosspostSettings(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequestError("request body must be a JSON object");
  }
  const { platforms } = body;
  if (typeof platforms !== "object" || platforms === null || Array.isArray(platforms)) {
    throw new BadRequestError("platforms must be a JSON object");
  }

  const credentials = {};
  const config = {};

  for (const [platform, settings] of Object.entries(platforms)) {
    if (!CROSSPOST_PLATFORM_KEYS.includes(platform)) {
      throw new BadRequestError(`unknown platform "${platform}" (expected one of ${CROSSPOST_PLATFORM_KEYS.join(", ")})`);
    }
    if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
      throw new BadRequestError(`platforms.${platform} must be a JSON object`);
    }

    const allowed = new Set(["token", ...Object.keys(CONFIG_FIELDS[platform])]);
    for (const key of Object.keys(settings)) {
      if (!allowed.has(key)) {
        throw new BadRequestError(`platforms.${platform}.${key} is not a recognized field`);
      }
    }

    if (settings.token !== undefined) {
      credentials[platform] = validateToken(settings.token, `platforms.${platform}.token`);
    }

    const entry = {};
    for (const [field, camel] of Object.entries(CONFIG_FIELDS[platform])) {
      if (settings[field] !== undefined) {
        entry[camel] = validateConfigValue(settings[field], field, `platforms.${platform}.${field}`);
      }
    }
    if (Object.keys(entry).length > 0) config[platform] = entry;
  }

  if (Object.keys(credentials).length === 0 && Object.keys(config).length === 0) {
    throw new BadRequestError("platforms must set or clear at least one field");
  }

  return { credentials, config };
}
