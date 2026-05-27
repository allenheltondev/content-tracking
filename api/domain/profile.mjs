import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { TABLE_NAME, ddb } from "../services/ddb.mjs";

// Account-level settings. This stack is effectively single-tenant (every
// authenticated Cognito user shares the same data), so settings live in one
// row rather than per-user:
//   pk = SETTINGS, sk = PROFILE
//
// Only non-secret config lives here (the GA4 property id). The GA4 service
// account and CrUX API key are secrets and live in SSM SecureStrings —
// see services/ga-secrets.mjs.

const PROFILE_KEY = { pk: "SETTINGS", sk: "PROFILE" };

export async function getProfileSettings() {
  const result = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: PROFILE_KEY,
  }));
  return result.Item ?? null;
}

// Upserts the supplied non-secret fields. Currently just ga4PropertyId;
// kept generic so future non-secret settings slot in without a new write
// path.
export async function saveProfileSettings(fields) {
  const entries = Object.entries(fields);
  if (entries.length === 0) {
    return getProfileSettings();
  }

  const now = new Date().toISOString();
  const names = { "#entity": "entity", "#updatedAt": "updatedAt" };
  const values = { ":entity": "Settings", ":updatedAt": now };
  const clauses = ["#entity = :entity", "#updatedAt = :updatedAt"];
  for (const [key, value] of entries) {
    names[`#${key}`] = key;
    values[`:${key}`] = value;
    clauses.push(`#${key} = :${key}`);
  }

  const result = await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: PROFILE_KEY,
    UpdateExpression: `SET ${clauses.join(", ")}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    ReturnValues: "ALL_NEW",
  }));
  return result.Attributes;
}
