import { BadRequestError } from "../services/errors.mjs";

// Validates the PUT /profile body. Every field is optional; only the ones
// present are applied (partial update). Returns a normalized object with
// internal field names:
//   ga4PropertyId    -> non-secret, stored in DynamoDB
//   ga4ServiceAccount -> secret, written to SSM
//   cruxApiKey       -> secret, written to SSM
//   brandName        -> non-secret, stored in DynamoDB; shown on shared reports
//   websiteUrl       -> non-secret, stored in DynamoDB; shown on shared reports
//   personalSiteUrl  -> non-secret, stored in DynamoDB; the creator's own site
//                       (used to detect self-published posts and pull their
//                       prebuilt plaintext for AI analysis)

const GA4_PROPERTY_ID_RE = /^\d{1,20}$/;
const CRUX_KEY_MAX = 200;
const BRAND_NAME_MAX = 80;
const WEBSITE_URL_MAX = 200;

export function validateProfileUpdate(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequestError("request body must be a JSON object");
  }

  const { ga4_property_id, ga4_service_account, crux_api_key, brand_name, website_url, personal_site_url } = body;
  const out = {};

  if (ga4_property_id !== undefined && ga4_property_id !== null && ga4_property_id !== "") {
    const value = String(ga4_property_id).trim();
    if (!GA4_PROPERTY_ID_RE.test(value)) {
      throw new BadRequestError("ga4_property_id must be the numeric GA4 property id (e.g. 123456789)");
    }
    out.ga4PropertyId = value;
  }

  if (ga4_service_account !== undefined && ga4_service_account !== null) {
    out.ga4ServiceAccount = validateServiceAccount(ga4_service_account);
  }

  if (crux_api_key !== undefined && crux_api_key !== null && crux_api_key !== "") {
    if (typeof crux_api_key !== "string" || crux_api_key.length > CRUX_KEY_MAX) {
      throw new BadRequestError(`crux_api_key must be a string up to ${CRUX_KEY_MAX} chars`);
    }
    out.cruxApiKey = crux_api_key.trim();
  }

  if (brand_name !== undefined && brand_name !== null && brand_name !== "") {
    if (typeof brand_name !== "string" || brand_name.trim().length === 0) {
      throw new BadRequestError("brand_name must be a non-empty string");
    }
    const value = brand_name.trim();
    if (value.length > BRAND_NAME_MAX) {
      throw new BadRequestError(`brand_name must be at most ${BRAND_NAME_MAX} chars`);
    }
    out.brandName = value;
  }

  if (website_url !== undefined && website_url !== null && website_url !== "") {
    out.websiteUrl = normalizeUrlField(website_url, "website_url");
  }

  if (personal_site_url !== undefined && personal_site_url !== null && personal_site_url !== "") {
    out.personalSiteUrl = normalizeUrlField(personal_site_url, "personal_site_url");
  }

  return out;
}

// Accepts a full URL or a bare host (readysetcloud.io); a missing scheme is
// assumed to be https so the stored value is always a usable absolute URL.
// `field` names the property in error messages so callers get specific
// feedback (website_url vs personal_site_url).
function normalizeUrlField(input, field) {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new BadRequestError(`${field} must be a non-empty string`);
  }
  let value = input.trim();
  // Only assume https for a bare host. An explicit non-http scheme (ftp://,
  // javascript:, ...) is left intact so the protocol check below rejects it
  // rather than it being masked by a prepended https://.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    value = `https://${value}`;
  }
  if (value.length > WEBSITE_URL_MAX) {
    throw new BadRequestError(`${field} must be at most ${WEBSITE_URL_MAX} chars`);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequestError(`${field} must be a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BadRequestError(`${field} must be an http(s) URL`);
  }
  return value;
}

// Accepts the Google service-account JSON either as an object or as the raw
// JSON string a user pastes from the downloaded key file. Validates the two
// fields we actually sign with so a malformed paste fails here rather than
// at GA4 call time.
function validateServiceAccount(input) {
  let sa = input;
  if (typeof input === "string") {
    try {
      sa = JSON.parse(input);
    } catch {
      throw new BadRequestError("ga4_service_account must be valid JSON");
    }
  }
  if (typeof sa !== "object" || sa === null || Array.isArray(sa)) {
    throw new BadRequestError("ga4_service_account must be a JSON object");
  }
  if (typeof sa.client_email !== "string" || sa.client_email.length === 0) {
    throw new BadRequestError("ga4_service_account is missing client_email");
  }
  if (typeof sa.private_key !== "string" || !sa.private_key.includes("PRIVATE KEY")) {
    throw new BadRequestError("ga4_service_account is missing a valid private_key");
  }
  return sa;
}
