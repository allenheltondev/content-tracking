import { BadRequestError } from "./errors.mjs";

// Pagination tokens. The DynamoDB LastEvaluatedKey is opaque to clients
// and base64 over JSON keeps it that way without forcing them to
// URL-encode whatever raw shape DDB hands back.

export function encodeCursor(lastEvaluatedKey) {
  if (!lastEvaluatedKey) return null;
  return Buffer.from(JSON.stringify(lastEvaluatedKey)).toString("base64");
}

export function decodeCursor(token) {
  if (token === undefined || token === null || token === "") return undefined;
  try {
    const decoded = Buffer.from(String(token), "base64").toString("utf8");
    const parsed = JSON.parse(decoded);
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("token did not decode to an object");
    }
    return parsed;
  } catch {
    throw new BadRequestError("startKey is not a valid pagination token");
  }
}

export function parseLimit(rawLimit, { defaultValue = 100, max = 500 } = {}) {
  if (rawLimit === undefined || rawLimit === null || rawLimit === "") return defaultValue;
  const parsed = Number(rawLimit);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new BadRequestError(`limit must be an integer between 1 and ${max}`);
  }
  return parsed;
}
