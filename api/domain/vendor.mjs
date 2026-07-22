import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import {
  TABLE_NAME,
  buildUpdateExpression,
  ddb,
  isConditionalCheckFailed,
  mapConditionalFailure,
} from "../services/ddb.mjs";
import { ConflictError, NotFoundError } from "../services/errors.mjs";

// Vendor records live at:
//   pk = VENDOR#{vendorId}, sk = METADATA
//
// They also write gsi1pk = "VENDORS" with gsi1sk = "{createdAt}#{vendorId}"
// so `listVendors` is a Query against GSI1 (no Scan).
//
// Campaign-by-vendor index entries (written by domain/campaign.mjs) live at
//   pk = VENDOR#{vendorId}, sk = CAMPAIGN#{campaignId}
// and don't carry GSI1 keys (they shouldn't appear in any "list all" view).

const VENDORS_PARTITION = "VENDORS";

function vendorKey(vendorId) {
  return { pk: `VENDOR#${vendorId}`, sk: "METADATA" };
}

export async function createVendor(fields) {
  // Callers may supply their own vendorId (slug) via validation; fall
  // back to a generated ULID when absent.
  const { vendorId: providedId, ...rest } = fields;
  const vendorId = providedId ?? ulid();
  const now = new Date().toISOString();
  const item = {
    ...vendorKey(vendorId),
    entity: "Vendor",
    vendorId,
    ...rest,
    gsi1pk: VENDORS_PARTITION,
    gsi1sk: `${now}#${vendorId}`,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await ddb.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: item,
      ConditionExpression: "attribute_not_exists(pk)",
    }));
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      throw new ConflictError(`Vendor ${vendorId} already exists`);
    }
    throw err;
  }

  return item;
}

export async function getVendor(vendorId) {
  const result = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: vendorKey(vendorId),
  }));
  if (!result.Item) {
    throw new NotFoundError("Vendor", vendorId);
  }
  return result.Item;
}

// Returns the vendor item (without throwing) for callers that need to
// know existence without a 404. Used by createCampaign.
export async function findVendor(vendorId) {
  const result = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: vendorKey(vendorId),
  }));
  return result.Item ?? null;
}

// Ownership guard for the vendor surface, mirroring assertCampaignOwned:
// vendors are stamped with the creator's tenantId, by-id routes verify it, and
// a mismatch (or absence) is a 404. Legacy vendors with no tenantId are
// grandfathered (existence-only).
export async function assertVendorOwned(vendorId, tenantId) {
  const vendor = await findVendor(vendorId);
  if (!vendor || (vendor.tenantId && vendor.tenantId !== tenantId)) {
    throw new NotFoundError("Vendor", vendorId);
  }
  return vendor;
}

export async function listVendors({ limit, exclusiveStartKey, tenantId }) {
  // Same sparse-page hazard as listCampaigns: the tenant FilterExpression is
  // applied after Limit, so a page can come back short (or empty) while more of
  // the caller's vendors sit deeper in the partition behind other tenants'
  // newer rows. Page internally until we've gathered a full `limit` of matches.
  const items = [];
  let cursor = exclusiveStartKey;
  do {
    const result = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: "GSI1",
      KeyConditionExpression: "gsi1pk = :pk",
      // Scope to the caller's own vendors plus legacy ones with no owner.
      FilterExpression: "(attribute_not_exists(tenantId) OR tenantId = :tenantId)",
      ExpressionAttributeValues: { ":pk": VENDORS_PARTITION, ":tenantId": tenantId },
      ScanIndexForward: false, // newest first
      Limit: limit,
      ExclusiveStartKey: cursor,
    }));
    items.push(...(result.Items ?? []));
    cursor = result.LastEvaluatedKey;
  } while (cursor && (limit === undefined || items.length < limit));

  // Trim an overshoot on the final page and resume from the last kept row.
  if (limit !== undefined && items.length > limit) {
    const page = items.slice(0, limit);
    const boundary = page[page.length - 1];
    return {
      items: page,
      lastEvaluatedKey: {
        pk: boundary.pk,
        sk: boundary.sk,
        gsi1pk: boundary.gsi1pk,
        gsi1sk: boundary.gsi1sk,
      },
    };
  }

  return { items, lastEvaluatedKey: cursor };
}

export async function updateVendor(vendorId, fields) {
  return mapConditionalFailure("Vendor", vendorId, async () => {
    const result = await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: vendorKey(vendorId),
      ...buildUpdateExpression(fields),
      ConditionExpression: "attribute_exists(pk)",
      ReturnValues: "ALL_NEW",
    }));
    return result.Attributes;
  });
}

export async function deleteVendor(vendorId) {
  // Refuse the delete if there are linked CampaignByVendor index entries.
  // Returning a 409 with the count gives the caller something actionable
  // instead of silently orphaning the index.
  const linked = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":pk": `VENDOR#${vendorId}`, ":prefix": "CAMPAIGN#" },
    Select: "COUNT",
  }));
  if ((linked.Count ?? 0) > 0) {
    throw new ConflictError(
      `Vendor ${vendorId} has ${linked.Count} linked campaign(s). Unlink or delete them first.`,
    );
  }

  await mapConditionalFailure("Vendor", vendorId, () =>
    ddb.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: vendorKey(vendorId),
      ConditionExpression: "attribute_exists(pk)",
    })),
  );
}

export async function listCampaignsForVendor(vendorId, tenantId) {
  // Confirm the vendor exists AND is owned by the caller first — returning
  // empty for a missing/foreign vendor would conflate "no campaigns yet" with
  // "not yours". assertVendorOwned 404s on either.
  await assertVendorOwned(vendorId, tenantId);

  const result = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":pk": `VENDOR#${vendorId}`, ":prefix": "CAMPAIGN#" },
  }));
  return result.Items ?? [];
}