import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { TABLE_NAME, ddb } from "../services/ddb.mjs";
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
    if (err instanceof ConditionalCheckFailedException || err?.name === "ConditionalCheckFailedException") {
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
  const result = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: "GSI1",
    KeyConditionExpression: "gsi1pk = :pk",
    // Scope to the caller's own vendors plus legacy ones with no owner.
    FilterExpression: "(attribute_not_exists(tenantId) OR tenantId = :tenantId)",
    ExpressionAttributeValues: { ":pk": VENDORS_PARTITION, ":tenantId": tenantId },
    ScanIndexForward: false, // newest first
    Limit: limit,
    ExclusiveStartKey: exclusiveStartKey,
  }));

  return {
    items: result.Items ?? [],
    lastEvaluatedKey: result.LastEvaluatedKey,
  };
}

export async function updateVendor(vendorId, fields) {
  const setClauses = [];
  const removeClauses = [];
  const names = { "#updatedAt": "updatedAt" };
  const values = { ":updatedAt": new Date().toISOString() };

  for (const [key, value] of Object.entries(fields)) {
    const namePlaceholder = `#${key}`;
    names[namePlaceholder] = key;
    if (value === null) {
      removeClauses.push(namePlaceholder);
    } else {
      const valuePlaceholder = `:${key}`;
      values[valuePlaceholder] = value;
      setClauses.push(`${namePlaceholder} = ${valuePlaceholder}`);
    }
  }
  setClauses.push("#updatedAt = :updatedAt");

  let updateExpression = `SET ${setClauses.join(", ")}`;
  if (removeClauses.length > 0) {
    updateExpression += ` REMOVE ${removeClauses.join(", ")}`;
  }

  try {
    const result = await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: vendorKey(vendorId),
      UpdateExpression: updateExpression,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression: "attribute_exists(pk)",
      ReturnValues: "ALL_NEW",
    }));
    return result.Attributes;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException || err?.name === "ConditionalCheckFailedException") {
      throw new NotFoundError("Vendor", vendorId);
    }
    throw err;
  }
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

  try {
    await ddb.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: vendorKey(vendorId),
      ConditionExpression: "attribute_exists(pk)",
    }));
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException || err?.name === "ConditionalCheckFailedException") {
      throw new NotFoundError("Vendor", vendorId);
    }
    throw err;
  }
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

// Surfaces TransactionCanceledException reasons so callers can handle
// individual condition failures (e.g., vendor disappeared between the
// existence check and the transaction).
export function isVendorTransactionCancelled(err) {
  if (err instanceof TransactionCanceledException) return true;
  return err?.name === "TransactionCanceledException";
}
