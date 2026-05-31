import { BadRequestError } from "../services/errors.mjs";

// Validates the creator-profile portion of the PUT /profile body — the
// rich, media-kit-facing fields that describe the creator themselves
// (as opposed to the GA4 / CrUX integration secrets handled by
// validation/profile.mjs). Every field is optional; only fields present
// in the body are applied (partial update). Passing an explicit null for
// a nullable field clears it. Returns a normalized object keyed by the
// internal camelCase attribute names stored on the SETTINGS/PROFILE row.

const DISPLAY_NAME_MAX = 80;
const TAGLINE_MAX = 160;
const BIO_MAX = 2000;
const LOCATION_MAX = 120;
const NICHE_MAX = 40;
const NICHES_MAX = 20;
const EMAIL_MAX = 320;
const HANDLE_MAX = 80;
const URL_MAX = 300;
const PLATFORM_MAX = 40;
const SOCIAL_ACCOUNTS_MAX = 30;
const RATE_CARD_MAX = 30;
const DELIVERABLE_MAX = 80;
const DESCRIPTION_MAX = 300;
const TESTIMONIALS_MAX = 20;
const QUOTE_MAX = 1000;
const PERSON_FIELD_MAX = 120;
const COLLABS_MAX = 20;
const AUDIENCE_NOTE_MAX = 500;
const AUDIENCE_LABEL_MAX = 60;
const AUDIENCE_BUCKETS_MAX = 30;
const COUNTRIES_MAX = 30;

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
// The vanity part of the public media-kit URL (https://<host>/<slug>).
// Lowercase letters, digits, and hyphens; 3-40 chars; no leading/trailing
// or doubled hyphen so the URL stays clean and unambiguous.
const SLUG_RE = /^[a-z0-9](?:[a-z0-9]|-(?!-)){1,38}[a-z0-9]$/;

// The image kinds the profile accepts and the content types behind them.
// Kept in sync with services/profile-assets.mjs (which owns the
// content-type -> extension mapping); duplicated here so the validation
// layer stays free of AWS-SDK imports.
const IMAGE_EXTENSIONS = ["png", "jpg", "webp", "gif"];
const IMAGE_CONTENT_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const IMAGE_KINDS = ["avatar", "logo"];
// Keys are minted server-side by presignProfileImageUpload, so we only
// accept values that match that exact shape rather than arbitrary strings.
const imageKeyRe = (kind) =>
  new RegExp(`^profile/${kind}-[0-9A-HJKMNP-TV-Z]{26}\\.(?:${IMAGE_EXTENSIONS.join("|")})$`);

// These keys map 1:1 from the API body to a trimmed, length-checked string
// stored under the corresponding internal name. Nullable: an explicit null
// clears the field.
const SIMPLE_STRINGS = [
  { key: "display_name", out: "displayName", max: DISPLAY_NAME_MAX, label: "display_name" },
  { key: "tagline", out: "tagline", max: TAGLINE_MAX, label: "tagline" },
  { key: "bio", out: "bio", max: BIO_MAX, label: "bio" },
  { key: "location", out: "location", max: LOCATION_MAX, label: "location" },
];

export function validateCreatorProfileUpdate(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequestError("request body must be a JSON object");
  }

  const out = {};

  for (const { key, out: outKey, max, label } of SIMPLE_STRINGS) {
    if (key in body) {
      out[outKey] = optionalTrimmedString(body[key], max, label);
    }
  }

  if ("contact_email" in body) {
    out.contactEmail = optionalEmail(body.contact_email);
  }

  if ("accent_color" in body) {
    out.accentColor = optionalHexColor(body.accent_color);
  }

  if ("public_slug" in body) {
    out.publicSlug = optionalSlug(body.public_slug);
  }

  if ("avatar_key" in body) {
    out.avatarKey = optionalImageKey(body.avatar_key, "avatar", "avatar_key");
  }

  if ("logo_key" in body) {
    out.logoKey = optionalImageKey(body.logo_key, "logo", "logo_key");
  }

  if ("niches" in body) {
    out.niches = optionalStringArray(body.niches, {
      maxItems: NICHES_MAX,
      maxLen: NICHE_MAX,
      label: "niches",
    });
  }

  if ("social_accounts" in body) {
    out.socialAccounts = optionalSocialAccounts(body.social_accounts);
  }

  if ("rate_card" in body) {
    out.rateCard = optionalRateCard(body.rate_card);
  }

  if ("testimonials" in body) {
    out.testimonials = optionalTestimonials(body.testimonials);
  }

  if ("featured_collaborations" in body) {
    out.featuredCollaborations = optionalCollaborations(body.featured_collaborations);
  }

  if ("audience" in body) {
    out.audience = optionalAudience(body.audience);
  }

  return out;
}

// --- field helpers -------------------------------------------------------

function optionalTrimmedString(value, max, label) {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new BadRequestError(`${label} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) {
    throw new BadRequestError(`${label} must be at most ${max} chars`);
  }
  return trimmed;
}

// A required string nested inside an array item — empty is rejected rather
// than coerced to null, since the surrounding item only exists because the
// caller meant to add it.
function requiredString(value, max, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BadRequestError(`${label} is required`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new BadRequestError(`${label} must be at most ${max} chars`);
  }
  return trimmed;
}

function nestedOptionalString(value, max, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new BadRequestError(`${label} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) {
    throw new BadRequestError(`${label} must be at most ${max} chars`);
  }
  return trimmed;
}

function optionalEmail(value) {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new BadRequestError("contact_email must be a string");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > EMAIL_MAX || !EMAIL_RE.test(trimmed)) {
    throw new BadRequestError("contact_email must be a valid email address");
  }
  return trimmed;
}

function optionalHexColor(value) {
  if (value === null) return null;
  if (typeof value !== "string" || !HEX_COLOR_RE.test(value.trim())) {
    throw new BadRequestError("accent_color must be a hex color like #1a2b3c");
  }
  return value.trim().toLowerCase();
}

function optionalSlug(value) {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new BadRequestError("public_slug must be a string");
  }
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  if (!SLUG_RE.test(trimmed)) {
    throw new BadRequestError(
      "public_slug must be 3-40 chars of lowercase letters, digits, or single hyphens",
    );
  }
  return trimmed;
}

function optionalImageKey(value, kind, label) {
  if (value === null) return null;
  if (typeof value !== "string" || !imageKeyRe(kind).test(value)) {
    throw new BadRequestError(`${label} must be a key returned by the profile image upload endpoint`);
  }
  return value;
}

function optionalUrl(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0) return null;
  let candidate = value.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }
  if (candidate.length > URL_MAX) {
    throw new BadRequestError(`${label} must be at most ${URL_MAX} chars`);
  }
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new BadRequestError(`${label} must be a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BadRequestError(`${label} must be an http(s) URL`);
  }
  return candidate;
}

function optionalNonNegativeNumber(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new BadRequestError(`${label} must be a non-negative number`);
  }
  return value;
}

function optionalStringArray(value, { maxItems, maxLen, label }) {
  if (value === null) return [];
  if (!Array.isArray(value)) {
    throw new BadRequestError(`${label} must be an array of strings`);
  }
  if (value.length > maxItems) {
    throw new BadRequestError(`${label} must have at most ${maxItems} items`);
  }
  const seen = new Set();
  const out = [];
  for (const entry of value) {
    const item = requiredString(entry, maxLen, `each ${label} entry`);
    if (!seen.has(item.toLowerCase())) {
      seen.add(item.toLowerCase());
      out.push(item);
    }
  }
  return out;
}

function asArray(value, label, max) {
  if (value === null) return [];
  if (!Array.isArray(value)) {
    throw new BadRequestError(`${label} must be an array`);
  }
  if (value.length > max) {
    throw new BadRequestError(`${label} must have at most ${max} items`);
  }
  return value;
}

function asObject(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BadRequestError(`each ${label} entry must be an object`);
  }
  return value;
}

function optionalSocialAccounts(value) {
  const items = asArray(value, "social_accounts", SOCIAL_ACCOUNTS_MAX);
  return items.map((raw) => {
    const item = asObject(raw, "social_accounts");
    const platform = requiredString(item.platform, PLATFORM_MAX, "social account platform");
    const handle = nestedOptionalString(item.handle, HANDLE_MAX, "social account handle");
    const url = optionalUrl(item.url, "social account url");
    if (!handle && !url) {
      throw new BadRequestError("each social account needs a handle or a url");
    }
    const followers = optionalNonNegativeNumber(item.followers, "social account followers");
    return {
      platform,
      handle,
      url,
      followers: followers === null ? null : Math.floor(followers),
    };
  });
}

function optionalRateCard(value) {
  const items = asArray(value, "rate_card", RATE_CARD_MAX);
  return items.map((raw) => {
    const item = asObject(raw, "rate_card");
    const deliverable = requiredString(item.deliverable, DELIVERABLE_MAX, "rate card deliverable");
    const description = nestedOptionalString(item.description, DESCRIPTION_MAX, "rate card description");
    const price = optionalNonNegativeNumber(item.price, "rate card price");
    let currency = null;
    if (item.currency !== undefined && item.currency !== null && item.currency !== "") {
      if (typeof item.currency !== "string" || !CURRENCY_RE.test(item.currency)) {
        throw new BadRequestError("rate card currency must be a 3-letter ISO 4217 code");
      }
      currency = item.currency;
    }
    return { deliverable, description, price, currency: currency ?? "USD" };
  });
}

function optionalTestimonials(value) {
  const items = asArray(value, "testimonials", TESTIMONIALS_MAX);
  return items.map((raw) => {
    const item = asObject(raw, "testimonials");
    return {
      quote: requiredString(item.quote, QUOTE_MAX, "testimonial quote"),
      author: nestedOptionalString(item.author, PERSON_FIELD_MAX, "testimonial author"),
      role: nestedOptionalString(item.role, PERSON_FIELD_MAX, "testimonial role"),
      company: nestedOptionalString(item.company, PERSON_FIELD_MAX, "testimonial company"),
    };
  });
}

function optionalCollaborations(value) {
  const items = asArray(value, "featured_collaborations", COLLABS_MAX);
  return items.map((raw) => {
    const item = asObject(raw, "featured_collaborations");
    let year = null;
    if (item.year !== undefined && item.year !== null && item.year !== "") {
      const n = Number(item.year);
      if (!Number.isInteger(n) || n < 1900 || n > 2999) {
        throw new BadRequestError("featured collaboration year must be between 1900 and 2999");
      }
      year = n;
    }
    return {
      brand: requiredString(item.brand, PERSON_FIELD_MAX, "featured collaboration brand"),
      description: nestedOptionalString(item.description, DESCRIPTION_MAX, "featured collaboration description"),
      url: optionalUrl(item.url, "featured collaboration url"),
      year,
    };
  });
}

// audience: { age_brackets: { "18-24": 30, ... }, gender: { ... },
// top_countries: [{ country, percent }], note }. Percentages are 0-100
// numbers; we store them as given (no sum-to-100 enforcement — surveys
// rarely add up cleanly and creators paste platform numbers verbatim).
function optionalAudience(value) {
  if (value === null) return null;
  const obj = asObject(value, "audience");
  const out = {};
  if ("age_brackets" in obj) {
    out.ageBrackets = optionalPercentMap(obj.age_brackets, "age_brackets");
  }
  if ("gender" in obj) {
    out.gender = optionalPercentMap(obj.gender, "gender");
  }
  if ("top_countries" in obj) {
    out.topCountries = optionalCountries(obj.top_countries);
  }
  if ("note" in obj) {
    out.note = nestedOptionalString(obj.note, AUDIENCE_NOTE_MAX, "audience note");
  }
  return out;
}

function optionalPercentMap(value, label) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestError(`audience ${label} must be an object of label -> percent`);
  }
  const entries = Object.entries(value);
  if (entries.length > AUDIENCE_BUCKETS_MAX) {
    throw new BadRequestError(`audience ${label} must have at most ${AUDIENCE_BUCKETS_MAX} entries`);
  }
  const out = {};
  for (const [rawLabel, pct] of entries) {
    const key = requiredString(rawLabel, AUDIENCE_LABEL_MAX, `audience ${label} label`);
    out[key] = percent(pct, `audience ${label} percent`);
  }
  return out;
}

function optionalCountries(value) {
  const items = asArray(value, "audience top_countries", COUNTRIES_MAX);
  return items.map((raw) => {
    const item = asObject(raw, "audience top_countries");
    return {
      country: requiredString(item.country, AUDIENCE_LABEL_MAX, "country name"),
      percent: percent(item.percent, "country percent"),
    };
  });
}

function percent(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new BadRequestError(`${label} must be a number between 0 and 100`);
  }
  return value;
}

// Validates the POST /profile/images/upload-url body. `kind` selects which
// image slot (avatar or logo) and `content_type` must be one of the
// supported image types; both are echoed back normalized.
export function validateProfileImageUploadRequest(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequestError("request body must be a JSON object");
  }
  const kind = body.kind;
  if (typeof kind !== "string" || !IMAGE_KINDS.includes(kind)) {
    throw new BadRequestError(`kind must be one of ${IMAGE_KINDS.join(", ")}`);
  }
  const contentType = body.content_type;
  if (typeof contentType !== "string" || !IMAGE_CONTENT_TYPES.includes(contentType)) {
    throw new BadRequestError(`content_type must be one of ${IMAGE_CONTENT_TYPES.join(", ")}`);
  }
  return { kind, contentType };
}
