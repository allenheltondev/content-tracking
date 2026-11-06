import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { TABLE_NAME, ddb, isConditionalCheckFailed } from "../services/ddb.mjs";
import { ConflictError, NotFoundError } from "../services/errors.mjs";
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
          ...(fields.tenantId ? { tenantId: fields.tenantId } : {}),
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

// Ownership guard for the campaign surface. Campaigns are stamped with the
// creator's `tenantId` at creation; every by-id route resolves the caller's
// tenant and calls this before touching the campaign or its children, so a
// caller can't reach another tenant's campaign. Returns 404 (not 403) on a
// mismatch so existence isn't leaked. Legacy campaigns created before scoping
// carry no `tenantId` and are grandfathered (existence-only) — the app's
// no-backfill stance. Returns the campaign so callers can reuse it.
export async function assertCampaignOwned(campaignId, tenantId) {
  const campaign = await findCampaign(campaignId);
  if (!campaign || (campaign.tenantId && campaign.tenantId !== tenantId)) {
    throw new NotFoundError("Campaign", campaignId);
  }
  return campaign;
}

// A FilterExpression fragment scoping a "list all" GSI query to the caller:
// their own campaigns plus legacy ones with no owner. Returns the clause and
// the values to merge into the query.
export function tenantScopeFilter(tenantId) {
  return {
    clause: "(attribute_not_exists(tenantId) OR tenantId = :tenantId)",
    values: { ":tenantId": tenantId },
  };
}

export async function listCampaigns({ limit, exclusiveStartKey, status, tenantId }) {
  const scope = tenantScopeFilter(tenantId);
  // Status filter applied via FilterExpression on the indexed Query, ANDed with
  // the tenant scope. Personal-scale dataset; the cost is a few extra RCUs on
  // filtered-out items. If status cardinality ever becomes a bottleneck we can
  // add a GSI keyed by `STATUS#{status}`.
  const names = {};
  let filterExpression = scope.clause;
  const values = { ":pk": CAMPAIGNS_PARTITION, ...scope.values };
  if (status) {
    filterExpression = `${scope.clause} AND #status = :status`;
    names["#status"] = "status";
    values[":status"] = status;
  }

  // DynamoDB applies the FilterExpression AFTER Limit, so a single page can
  // come back with fewer than `limit` matches — or none — even when more of the
  // caller's campaigns exist deeper in the partition (the newer rows scanned
  // first may belong to other tenants). Callers like the Campaigns page don't
  // chase nextStartKey, so page internally until we've gathered a full `limit`
  // of matching rows (or exhausted the partition).
  const items = [];
  let cursor = exclusiveStartKey;
  do {
    const result = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: "GSI1",
      KeyConditionExpression: "gsi1pk = :pk",
      FilterExpression: filterExpression,
      ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
      ExpressionAttributeValues: values,
      ScanIndexForward: false, // newest first
      Limit: limit,
      ExclusiveStartKey: cursor,
    }));
    items.push(...(result.Items ?? []));
    cursor = result.LastEvaluatedKey;
  } while (cursor && (limit === undefined || items.length < limit));

  // Internal paging can overshoot `limit` on the final page; trim to the
  // requested size and hand back a cursor positioned at the last kept row so
  // the next call resumes exactly after it (the boundary item carries the four
  // GSI1 key attributes an ExclusiveStartKey needs).
  if (limit !== undefined && items.length > limit) {
    const page = items.slice(0, limit);
    const boundary = page[page.length - 1];
    return { items: page, lastEvaluatedKey: gsi1Cursor(boundary) };
  }

  return { items, lastEvaluatedKey: cursor };
}

// Builds an ExclusiveStartKey for the GSI1 "CAMPAIGNS" partition from a row we
// just returned: a GSI query cursor needs both the table key (pk/sk) and the
// index key (gsi1pk/gsi1sk).
function gsi1Cursor(item) {
  return { pk: item.pk, sk: item.sk, gsi1pk: item.gsi1pk, gsi1sk: item.gsi1sk };
}

// Drains the paginated campaign list into a flat array, every status
// included. Used by the account-wide aggregates (insights, media kit)
// that span all campaigns. Memory-unbounded by design at personal scale;
// revisit if the campaign count ever makes a full materialization risky.
export async function listAllCampaigns(tenantId) {
  const all = [];
  let exclusiveStartKey;
  do {
    const { items, lastEvaluatedKey } = await listCampaigns({
      limit: 500,
      exclusiveStartKey,
      tenantId,
    });
    for (const item of items) all.push(item);
    exclusiveStartKey = lastEvaluatedKey;
  } while (exclusiveStartKey);
  return all;
}

// Campaigns at a given status for a tenant. Pages the GSI1 "CAMPAIGNS"
// partition with a status + tenant filter; the data set is personal-scale so
// we fully consume it.
export async function listCampaignsByStatus(status, tenantId) {
  const scope = tenantScopeFilter(tenantId);
  const items = [];
  let exclusiveStartKey;
  do {
    const result = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: "GSI1",
      KeyConditionExpression: "gsi1pk = :pk",
      FilterExpression: `#status = :status AND ${scope.clause}`,
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":pk": CAMPAIGNS_PARTITION,
        ":status": status,
        ...scope.values,
      },
      ExclusiveStartKey: exclusiveStartKey,
    }));
    for (const it of result.Items ?? []) items.push(it);
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items;
}

// Back-compat shim — older call sites still ask for "active" campaigns.
export function listActiveCampaigns(tenantId) {
  return listCampaignsByStatus("active", tenantId);
}

// Used by the /revenue rollup. Queries a tenant's campaigns whose createdAt
// falls in [startDate, endDate]. Pages internally — for personal scale
// the result set is small enough to fully consume.
export async function queryCampaignsByDateRange({ startDate, endDate, tenantId }) {
  const scope = tenantScopeFilter(tenantId);
  const items = [];
  let exclusiveStartKey;
  do {
    const result = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: "GSI1",
      KeyConditionExpression: "gsi1pk = :pk AND gsi1sk BETWEEN :start AND :end",
      FilterExpression: scope.clause,
      ExpressionAttributeValues: {
        ":pk": CAMPAIGNS_PARTITION,
        // gsi1sk format: "{createdAt}#{campaignId}". The "#~" upper bound
        // sorts above any "{date}#{ulid}" because '~' (0x7e) sorts above
        // every Crockford base32 character used in ULIDs.
        ":start": `${startDate}T00:00:00.000Z#`,
        ":end": `${endDate}T23:59:59.999Z#~`,
        ...scope.values,
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

//
// `expectStatus`, when set, makes the write conditional on the campaign
// still having that status (undefined means a legacy row with no status),
// so a lifecycle check made on an earlier read can't be bypassed by a
// concurrent change. A mismatch throws ConflictError and writes nothing;
// the vendor mirror rides the same transaction, so it is covered too.
export async function updateCampaignFields(campaignId, fields, options = {}) {
  const guard = statusGuard("expectStatus" in options, options.expectStatus);
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
    return guarded(campaignId, guard, () => reassignVendorAndUpdate(campaignId, existing, fields, guard));
  }

  const built = buildSetExpression(entries);
  const expression = built.expression;
  const names = { ...built.names, ...guard.names };
  const values = { ...built.values, ...guard.values };

  // No vendor companion row to keep in sync: a single conditional Update
  // is enough and lets us return the post-update item directly.
  if (!existing.vendorId) {
    return guarded(campaignId, guard, async () => {
      const result = await ddb.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: campaignKey(campaignId),
        UpdateExpression: expression,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ConditionExpression: guard.condition,
        ReturnValues: "ALL_NEW",
      }));
      return result.Attributes;
    });
  }

  const transactItems = [{
    Update: {
      TableName: TABLE_NAME,
      Key: campaignKey(campaignId),
      UpdateExpression: expression,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression: guard.condition,
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

  await guarded(campaignId, guard, () => ddb.send(new TransactWriteCommand({ TransactItems: transactItems })));
  return { ...existing, ...fields };
}

// Re-links a campaign to a different vendor (or links one for the first
// time) while applying any other edited fields in the same transaction.
// Keeps the VENDOR#{v}/CAMPAIGN#{c} companion rows accurate: the old
// vendor's row is removed and the new vendor's row is (over)written so
// each vendor's campaign list stays in sync. The chosen vendor's name is
// snapshotted into `sponsor` unless the caller supplied one, mirroring
// createCampaign so the display name survives without an extra read.
async function reassignVendorAndUpdate(campaignId, existing, fields, guard = statusGuard(false)) {
  const newVendorId = fields.vendorId;
  const oldVendorId = existing.vendorId ?? null;

  const vendor = await findVendor(newVendorId);
  if (!vendor) {
    throw new NotFoundError("Vendor", newVendorId);
  }

  const effectiveFields =
    fields.sponsor === undefined ? { ...fields, sponsor: vendor.name } : fields;
  const merged = { ...existing, ...effectiveFields };
  const built = buildSetExpression(Object.entries(effectiveFields));

  const transactItems = [{
    Update: {
      TableName: TABLE_NAME,
      Key: campaignKey(campaignId),
      UpdateExpression: built.expression,
      ExpressionAttributeNames: { ...built.names, ...guard.names },
      ExpressionAttributeValues: { ...built.values, ...guard.values },
      ConditionExpression: guard.condition,
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

// The campaign row's write condition. Always requires the row to exist;
// with an expected status it also requires the stored status to match.
function statusGuard(enabled, expectStatus) {
  if (!enabled) {
    return { enabled: false, condition: "attribute_exists(pk)", names: {}, values: {} };
  }
  if (expectStatus === undefined || expectStatus === null) {
    return {
      enabled: true,
      condition: "attribute_exists(pk) AND attribute_not_exists(#status)",
      names: { "#status": "status" },
      values: {},
    };
  }
  return {
    enabled: true,
    condition: "attribute_exists(pk) AND #status = :expectedStatus",
    names: { "#status": "status" },
    values: { ":expectedStatus": expectStatus },
  };
}

// Runs a guarded write and turns a failed status condition into a
// ConflictError (or NotFoundError if the campaign vanished). Unguarded
// writes pass errors through unchanged, as before.
async function guarded(campaignId, guard, write) {
  try {
    return await write();
  } catch (err) {
    if (!guard.enabled || !isCampaignConditionFailure(err)) throw err;
    const current = await findCampaign(campaignId);
    if (!current) throw new NotFoundError("Campaign", campaignId);
    throw new ConflictError(
      `Campaign ${campaignId} changed to ${current.status ?? "active"} while this update ran. Read it again and retry.`,
    );
  }
}

// A plain Update fails with ConditionalCheckFailedException; a transaction
// fails with TransactionCanceledException whose first reason (the campaign
// row) is ConditionalCheckFailed.
function isCampaignConditionFailure(err) {
  if (isConditionalCheckFailed(err)) return true;
  return err?.name === "TransactionCanceledException" &&
    err?.CancellationReasons?.[0]?.Code === "ConditionalCheckFailed";
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

  // DynamoDB rejects an expression whose paths overlap, so `SET #payout =
  // if_not_exists(...)` cannot share a statement with `SET #payout.#x = ...`.
  // Write the nested fields first (requires the map to exist); when the
  // campaign has no payout map yet, create it in its own update and retry.
  const expressionParts = [];
  if (setClauses.length > 0) {
    expressionParts.push(`SET ${setClauses.join(", ")}`);
  }
  if (removeClauses.length > 0) {
    expressionParts.push(`REMOVE ${removeClauses.join(", ")}`);
  }

  const send = (extra) => ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: campaignKey(campaignId),
    UpdateExpression: expressionParts.join(" "),
    ExpressionAttributeNames: names,
    ...(Object.keys(values).length > 0 ? { ExpressionAttributeValues: values } : {}),
    ConditionExpression: "attribute_exists(pk) AND attribute_exists(#payout)",
    ReturnValues: "ALL_NEW",
    ...extra,
  }));

  try {
    let result;
    try {
      result = await send();
    } catch (err) {
      if (!isConditionalCheckFailed(err)) throw err;
      await ddb.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: campaignKey(campaignId),
        UpdateExpression: "SET #payout = if_not_exists(#payout, :empty)",
        ExpressionAttributeNames: { "#payout": "payout" },
        ExpressionAttributeValues: { ":empty": {} },
        ConditionExpression: "attribute_exists(pk)",
      }));
      result = await send();
    }
    return result.Attributes;
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      throw new NotFoundError("Campaign", campaignId);
    }
    throw err;
  }
}

