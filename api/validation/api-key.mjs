import { BadRequestError } from "../services/errors.mjs";

// API key access levels. "read" keys may only call read-only operations
// (the read-only MCP tools); "write" keys may also publish content and use
// every MCP tool. Keys minted before access levels existed carry no
// attribute and are treated as "write", which is what they could already
// do.
export const API_KEY_ACCESS = ["read", "write"];
export const DEFAULT_API_KEY_ACCESS = "write";
const LABEL_MAX = 60;

// Validates POST /api-keys. Both fields are optional: a missing label is
// defaulted by the route, a missing access is "write".
export function validateApiKeyCreate(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequestError("request body must be a JSON object");
  }
  const { label, access } = body;
  const out = { label: null, access: DEFAULT_API_KEY_ACCESS };

  if (label !== undefined && label !== null) {
    if (typeof label !== "string") {
      throw new BadRequestError("label must be a string");
    }
    const trimmed = label.trim();
    if (trimmed.length > LABEL_MAX) {
      throw new BadRequestError(`label must be ${LABEL_MAX} characters or fewer`);
    }
    out.label = trimmed || null;
  }

  if (access !== undefined && access !== null) {
    if (!API_KEY_ACCESS.includes(access)) {
      throw new BadRequestError(`access must be one of ${API_KEY_ACCESS.join(", ")}`);
    }
    out.access = access;
  }

  return out;
}
