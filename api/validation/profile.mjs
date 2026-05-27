import { BadRequestError } from "../services/errors.mjs";

// Validates the PUT /profile body. Every field is optional; only the ones
// present are applied (partial update). Returns a normalized object with
// internal field names:
//   ga4PropertyId    -> non-secret, stored in DynamoDB
//   ga4ServiceAccount -> secret, written to SSM
//   cruxApiKey       -> secret, written to SSM

const GA4_PROPERTY_ID_RE = /^\d{1,20}$/;
const CRUX_KEY_MAX = 200;

export function validateProfileUpdate(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequestError("request body must be a JSON object");
  }

  const { ga4_property_id, ga4_service_account, crux_api_key } = body;
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

  return out;
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
