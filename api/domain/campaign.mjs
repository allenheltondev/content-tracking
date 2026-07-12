import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { TABLE_NAME, ddb } from "../services/ddb.mjs";
import { NotFoundError } from "../services/errors.mjs";
import { findVendor } from "./vendor.mjs";

// Campaign records live at:
//   pk = CAMPAIGN#{campaignId}, sk = METADATA
// with GSI1 keys:
//   gsi1pk = "CAMPAIGNS"
//   gsi1sk = "{createdAt}#{campaignId}"
//
// Linked Link records sit under the same pk with sk = LINK#{linkId} and
// have no GSI1 keys (they shouldn't appear in any "list all campaigns"
// view). domain/link.mjs owns those.
//
// When a campaign is created with a vendor_id, a companion entry is
// written transactionally at pk = VENDOR#{vendorId}, sk = CAMPAIGN#{cid}
// so GET /vendors/{id}/campaigns is one Query.

const CAMPAIGNS_PARTITION = "CAMPAIGNS";

// Exported so the content domain can write the campaign's `contentId`
// back-pointer transactionally when a sponsorship is attached to a piece of
// content (the campaign hangs off the content piece, 1:1).
export function campaignKey(campaignId) {
  return { pk: `CAMPAIGN#${campaignId}`, sk: "METADATA" };
}

export async function createCampaign(fields) {
  // If the caller supplied a vendor, confirm it exists before writing the
  // transaction. A TransactionCanceledException out of the transaction
  // wouldn't tell us which item's condition failed; the explicit pre-check
  // lets us return a clean 404 referencing the vendor.
  let vendor = null;
  if (fields.vendorId) {
    vendor = await findVendor(fields.vendorId);
    if (!vendor) {
      throw new NotFoundError("Vendor", fields.vendorId);
    }
  }

  // Snapshot the vendor name into `sponsor` when the caller picked a
  // vendor but didn't type a separate sponsor string. Keeps the display
  // working without a second read on the detail page, and gives the user
  // a starting value to edit if the vendor is later renamed.
  const sponsoredFields =
    vendor && !fields.sponsor ? { ...fields, sponsor: vendor.name } : fields;

  const campaignId = ulid();
  const now = new Date().toISOString();
  const metadata = {
    ...campaignKey(campaignId),
    entity: "Campaign",
    campaignId,
    ...sponsoredFields,
    gsi1pk: CAMPAIGNS_PARTITION,
    gsi1sk: `${now}#${campaignId}`,
    createdAt: now,
  };

  const transactItems = [{
    Put: {
      TableName: TABLE_NAME,
      Item: metadata,
      ConditionExpression: "attribute_not_exists(pk)",
    },
  }];

  if (fields.vendorId) {
    transactItems.push({
      Put: {
        TableName: TABLE_NAME,
        Item: {
          pk: `VENDOR#${fields.vendorId}`,
          sk: `CAMPAIGN#${campaignId}`,
          entity: "CampaignByVendor",
          campaignId,
          vendorId: fields.vendorId,
          name: metadata.name,
          status: metadata.status,
          startDate: metadata.startDate,
          endDate: metadata.endDate,
          createdAt: now,
        },
        ConditionExpression: "attribute_not_exists(pk)",
      },
    });
  }

  await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));
  return metadata;
}

// Returns the metadata + every link + the attached brief + the draft (each
// if present) for the campaign. The existing /campaigns/{id} endpoint
// exposes them as a single read; the brief (sk = BRIEF) and draft
// (sk = DRAFT) live under the same pk so they ride along on the one Query.
export async function getCampaignWithLinks(campaignId) {
  const result = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: "pk = :pk",
    ExpressionAttributeValues: { ":pk": `CAMPAIGN#${campaignId}` },
  }));
  const items = result.Items ?? [];
  const metadata = items.find((it) => it.sk === "METADATA");
  if (!metadata) {
    throw new NotFoundError("Campaign", campaignId);
  }
  const links = items.filter((it) => typeof it.sk === "string" && it.sk.startsWith("LINK#"));
  // SocialPost / ContentPost daily snapshots also live under
  // sk = {SOCIAL|CONTENT}POST#{postId}#SNAPSHOT#{date}, so a startsWith
  // filter would sweep them in. Match on entity instead.
  const socialPosts = items.filter((it) => it.entity === "SocialPost");
  const contentPosts = items.filter((it) => it.entity === "ContentPost");
  const brief = items.find((it) => it.sk === "BRIEF") ?? null;
  const draft = items.find((it) => it.sk === "DRAFT") ?? null;
  return { metadata, links, socialPosts, contentPosts, brief, draft };
}

export async function findCampaign(campaignId) {
  const result = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: campaignKey(campaignId),
  }));
  return result.Item ?? null;
}

export async function listCampaigns({ limit, exclusiveStartKey, status }) {
  const args = {
    TableName: TABLE_NAME,
    IndexName: "GSI1",
    KeyConditionExpression: "gsi1pk = :pk",
    ExpressionAttributeValues: { ":pk": CAMPAIGNS_PARTITION },
    ScanIndexForward: false, // newest first
    Limit: limit,
    ExclusiveStartKey: exclusiveStartKey,
  };

  // Status filter applied via FilterExpression on the indexed Query.
  // Personal-scale dataset; the cost is a few extra RCUs on filtered-out
  // items. If status cardinality ever becomes a bottleneck we can add
  // a GSI keyed by `STATUS#{status}`.
  if (status) {
    args.FilterExpression = "#status = :status";
    args.ExpressionAttributeNames = { "#status": "status" };
    args.ExpressionAttributeValues[":status"] = status;
  }

  const result = await ddb.send(new QueryCommand(args));
  return {
    items: result.Items ?? [],
    lastEvaluatedKey: result.LastEvaluatedKey,
  };
}

// Campaigns at a given status. Pages the GSI1 "CAMPAIGNS" partition with a
// status filter; the data set is personal-scale so we fully consume it.
export async function listCampaignsByStatus(status) {
  const items = [];
  let exclusiveStartKey;
  do {
    const result = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: "GSI1",
      KeyConditionExpression: "gsi1pk = :pk",
      FilterExpression: "#status = :status",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":pk": CAMPAIGNS_PARTITION,
        ":status": status,
      },
      ExclusiveStartKey: exclusiveStartKey,
    }));
    for (const it of result.Items ?? []) items.push(it);
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items;
}

// Back-compat shim — older call sites still ask for "active" campaigns.
export function listActiveCampaigns() {
  return listCampaignsByStatus("active");
}

// Used by the /revenue rollup. Queries all campaigns whose createdAt
// falls in [startDate, endDate]. Pages internally — for personal scale
// the result set is small enough to fully consume.
export async function queryCampaignsByDateRange({ startDate, endDate }) {
  const items = [];
  let exclusiveStartKey;
  do {
    const result = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: "GSI1",
      KeyConditionExpression: "gsi1pk = :pk AND gsi1sk BETWEEN :start AND :end",
      ExpressionAttributeValues: {
        ":pk": CAMPAIGNS_PARTITION,
        // gsi1sk format: "{createdAt}#{campaignId}". The "#~" upper bound
        // sorts above any "{date}#{ulid}" because '~' (0x7e) sorts above
        // every Crockford base32 character used in ULIDs.
        ":start": `${startDate}T00:00:00.000Z#`,
        ":end": `${endDate}T23:59:59.999Z#~`,
      },
      ExclusiveStartKey: exclusiveStartKey,
    }));
    for (const it of result.Items ?? []) items.push(it);
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items;
}

// Applies a set of edited fields to a campaign — used when the user
// accepts brief-suggested updates. Accepts any of: name, sponsor,
// startDate, endDate, status, targetMetrics, payout. `payout` is replaced
// wholesale (not merged) since the brief-apply form submits the full
// object; partial payout edits still go through PATCH /payout.
//
// name/status/startDate/endDate are also mirrored on the VENDOR#{v} /
// CAMPAIGN#{c} companion row, so when the campaign has a vendor we update
// both rows in one transaction to keep the vendor's campaign list in sync.
const MIRRORED_FIELDS = ["name", "status", "startDate", "endDate"];

export async function updateCampaignFields(campaignId, fields) {
  const existing = await findCampaign(campaignId);
  if (!existing) {
    throw new NotFoundError("Campaign", campaignId);
  }

  const entries = Object.entries(fields);
  if (entries.length === 0) {
    return existing;
  }

  const oldVendorId = existing.vendorId ?? null;
  const vendorChanging =
    Object.prototype.hasOwnProperty.call(fields, "vendorId") &&
    (fields.vendorId ?? null) !== oldVendorId;
  if (vendorChanging) {
    return reassignVendorAndUpdate(campaignId, existing, fields);
  }

  const { expression, names, values } = buildSetExpression(entries);

  // No vendor companion row to keep in sync: a single conditional Update
  // is enough and lets us return the post-update item directly.
  if (!existing.vendorId) {
    const result = await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: campaignKey(campaignId),
      UpdateExpression: expression,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression: "attribute_exists(pk)",
      ReturnValues: "ALL_NEW",
    }));
    return result.Attributes;
  }

  const transactItems = [{
    Update: {
      TableName: TABLE_NAME,
      Key: campaignKey(campaignId),
      UpdateExpression: expression,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression: "attribute_exists(pk)",
    },
  }];

  const mirrored = entries.filter(([key]) => MIRRORED_FIELDS.includes(key));
  if (mirrored.length > 0) {
    const mirror = buildSetExpression(mirrored);
    transactItems.push({
      Update: {
        TableName: TABLE_NAME,
        Key: { pk: `VENDOR#${existing.vendorId}`, sk: `CAMPAIGN#${campaignId}` },
        UpdateExpression: mirror.expression,
        ExpressionAttributeNames: mirror.names,
        ExpressionAttributeValues: mirror.values,
        ConditionExpression: "attribute_exists(pk)",
      },
    });
  }

  await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));
  return { ...existing, ...fields };
}

// Re-links a campaign to a different vendor (or links one for the first
// time) while applying any other edited fields in the same transaction.
// Keeps the VENDOR#{v}/CAMPAIGN#{c} companion rows accurate: the old
// vendor's row is removed and the new vendor's row is (over)written so
// each vendor's campaign list stays in sync. The chosen vendor's name is
// snapshotted into `sponsor` unless the caller supplied one, mirroring
// createCampaign so the display name survives without an extra read.
async function reassignVendorAndUpdate(campaignId, existing, fields) {
  const newVendorId = fields.vendorId;
  const oldVendorId = existing.vendorId ?? null;

  const vendor = await findVendor(newVendorId);
  if (!vendor) {
    throw new NotFoundError("Vendor", newVendorId);
  }

  const effectiveFields =
    fields.sponsor === undefined ? { ...fields, sponsor: vendor.name } : fields;
  const merged = { ...existing, ...effectiveFields };
  const { expression, names, values } = buildSetExpression(Object.entries(effectiveFields));

  const transactItems = [{
    Update: {
      TableName: TABLE_NAME,
      Key: campaignKey(campaignId),
      UpdateExpression: expression,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression: "attribute_exists(pk)",
    },
  }];

  if (oldVendorId) {
    transactItems.push({
      Delete: {
        TableName: TABLE_NAME,
        Key: { pk: `VENDOR#${oldVendorId}`, sk: `CAMPAIGN#${campaignId}` },
      },
    });
  }

  transactItems.push({
    Put: {
      TableName: TABLE_NAME,
      Item: {
        pk: `VENDOR#${newVendorId}`,
        sk: `CAMPAIGN#${campaignId}`,
        entity: "CampaignByVendor",
        campaignId,
        vendorId: newVendorId,
        name: merged.name,
        status: merged.status,
        startDate: merged.startDate,
        endDate: merged.endDate,
        createdAt: existing.createdAt,
      },
    },
  });

  await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));
  return merged;
}

function buildSetExpression(entries) {
  const names = {};
  const values = {};
  const clauses = [];
  for (const [key, value] of entries) {
    names[`#${key}`] = key;
    values[`:${key}`] = value;
    clauses.push(`#${key} = :${key}`);
  }
  return { expression: `SET ${clauses.join(", ")}`, names, values };
}

export async function updateCampaignPayout(campaignId, fields) {
  // Same map-update pattern as PR #30: nest under `payout`, REMOVE on
  // null sub-fields, default the parent map to empty so it works on
  // campaigns that have no payout yet.
  const setClauses = [];
  const removeClauses = [];
  const names = { "#payout": "payout" };
  const values = {};

  for (const [key, value] of Object.entries(fields)) {
    const namePlaceholder = `#${key}`;
    names[namePlaceholder] = key;
    if (value === null) {
      removeClauses.push(`#payout.${namePlaceholder}`);
    } else {
      const valuePlaceholder = `:${key}`;
      values[valuePlaceholder] = value;
      setClauses.push(`#payout.${namePlaceholder} = ${valuePlaceholder}`);
    }
  }

  const expressionParts = [];
  let setClause = "SET #payout = if_not_exists(#payout, :empty)";
  if (setClauses.length > 0) {
    setClause += `, ${setClauses.join(", ")}`;
  }
  expressionParts.push(setClause);
  if (removeClauses.length > 0) {
    expressionParts.push(`REMOVE ${removeClauses.join(", ")}`);
  }
  values[":empty"] = {};

  try {
    const result = await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: campaignKey(campaignId),
      UpdateExpression: expressionParts.join(" "),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression: "attribute_exists(pk)",
      ReturnValues: "ALL_NEW",
    }));
    return result.Attributes;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException || err?.name === "ConditionalCheckFailedException") {
      throw new NotFoundError("Campaign", campaignId);
    }
    throw err;
  }
}

