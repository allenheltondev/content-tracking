import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { TABLE_NAME, ddb } from "../services/ddb.mjs";

// Per-tenant configuration: the non-secret platform targets the legacy
// blog-service hardcoded (publication ids, canonical base URL, admin
// email). Secrets (platform tokens) live in SSM via blog-credentials.mjs,
// not here. See docs/blog-tracking-data-model.md.
//
//   pk = TENANT#{tenantId}, sk = #CONFIG
//   gsi1pk = "TENANTS", gsi1sk = {tenantId}
//
// The "TENANTS" GSI bucket lets the weekly analytics job enumerate
// tenants — the one intentional cross-tenant read, done by the system.

const TENANTS_PARTITION = "TENANTS";
const CONFIG_SK = "#CONFIG";

export function tenantConfigKey(tenantId) {
  return { pk: `TENANT#${tenantId}`, sk: CONFIG_SK };
}

// Returns the tenant config item, or null when the tenant has not
// configured one yet (so GET /tenant can report the unconfigured state
// rather than 404 on a fresh sign-in).
export async function getTenant(tenantId) {
  const result = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: tenantConfigKey(tenantId),
  }));
  return result.Item ?? null;
}

// Merges one level deep so a PUT that touches only one platform doesn't
// drop the others. config.platforms[p] is overlaid onto existing[p].
function mergePlatforms(existing = {}, incoming = {}) {
  const out = { ...existing };
  for (const [platform, settings] of Object.entries(incoming)) {
    out[platform] = { ...(existing[platform] ?? {}), ...settings };
  }
  return out;
}

// Create-or-update the tenant config. Merges the validated fields over any
// existing config (preserving createdAt and untouched platform settings)
// so callers can send partial updates.
export async function upsertTenant(tenantId, config) {
  const existing = await getTenant(tenantId);
  const now = new Date().toISOString();

  const { platforms: incomingPlatforms, ...rest } = config;
  const item = {
    ...(existing ?? {}),
    ...rest,
    ...tenantConfigKey(tenantId),
    entity: "Tenant",
    tenantId,
    gsi1pk: TENANTS_PARTITION,
    gsi1sk: tenantId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  if (incomingPlatforms || existing?.platforms) {
    item.platforms = mergePlatforms(existing?.platforms, incomingPlatforms ?? {});
  }

  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: item,
  }));

  return item;
}

// Enumerates every tenant config (weekly analytics job). Paginated like
// the other list reads.
export async function listTenants({ limit, exclusiveStartKey } = {}) {
  const result = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: "GSI1",
    KeyConditionExpression: "gsi1pk = :pk",
    ExpressionAttributeValues: { ":pk": TENANTS_PARTITION },
    Limit: limit,
    ExclusiveStartKey: exclusiveStartKey,
  }));

  return {
    items: result.Items ?? [],
    lastEvaluatedKey: result.LastEvaluatedKey,
  };
}
