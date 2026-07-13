import { ConditionalCheckFailedException, TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { TABLE_NAME, ddb } from "../services/ddb.mjs";
import { ConflictError, NotFoundError } from "../services/errors.mjs";
import { tenantPartition } from "./blog.mjs";
import { campaignKey, findCampaign } from "./campaign.mjs";

// Content records are tenant-scoped by partition. Everything for a tenant
// lives under pk = TENANT#{tenantId} where tenantId is the Cognito sub
// from the authorizer (never the client). This gives structural
// isolation: a handler can only ever query its own tenant's partition.
// This entity is the foundation of a content-model unification and mirrors
// the Blog entity's shape exactly.
//
//   Content root      pk=TENANT#{tenantId}  sk=CONTENT#{contentId}
//   Publish variant   pk=TENANT#{tenantId}  sk=CONTENT#{contentId}#PUBLISH#{platform}
//   Stats snapshot    pk=TENANT#{tenantId}  sk=CONTENT#{contentId}#STATS#{platform}#{date}
//   Vector state      pk=TENANT#{tenantId}  sk=CONTENT#{contentId}#VECTORINDEX
//
// The content ROOT also writes gsi1pk = "TENANT#{tenantId}#CONTENT" with
// gsi1sk = "{createdAt}#{contentId}", so listContentByTenant is a clean
// Query against GSI1 that returns roots only — child rows carry no GSI1
// keys.

function contentListPartition(tenantId) {
  return `TENANT#${tenantId}#CONTENT`;
}

export function contentKey(tenantId, contentId) {
  return { pk: tenantPartition(tenantId), sk: `CONTENT#${contentId}` };
}

// Child-key helpers, exported so the publish + analytics flows share the
// key shapes in one place.
export function publishVariantKey(tenantId, contentId, platform) {
  return { pk: tenantPartition(tenantId), sk: `CONTENT#${contentId}#PUBLISH#${platform}` };
}

export function statsKey(tenantId, contentId, platform, date) {
  return { pk: tenantPartition(tenantId), sk: `CONTENT#${contentId}#STATS#${platform}#${date}` };
}

// Tracks what's been vectorized for a piece of content so the stream-driven
// vectorizer can skip re-embedding when the body text is unchanged and knows
// how many chunk vectors exist to clean up. Lives under the CONTENT#{contentId}
// prefix so deleteContent's cascade removes it for free. Its entity
// (ContentVectorIndex) differs from the root (Content), so the stream filter
// that watches Content roots never re-fires on this row's own writes.
export function contentVectorStateKey(tenantId, contentId) {
  return { pk: tenantPartition(tenantId), sk: `CONTENT#${contentId}#VECTORINDEX` };
}

// Attributes the partial update must never touch: keys, identity,
// immutable metadata, and the maps the publish flow owns. links/ids
// are excluded so a content edit can't clobber the per-platform copy URLs
// and ids written during publishing. canonicalUrl IS editable and is
// mirrored into links.url (see updateContent).
const PROTECTED_UPDATE_FIELDS = new Set([
  "pk",
  "sk",
  "contentId",
  "tenantId",
  "entity",
  "createdAt",
  "gsi1pk",
  "gsi1sk",
  "links",
  "ids",
  // campaignId owns a bidirectional 1:1 link and a back-pointer on the
  // campaign row, so it must never be written through the generic partial
  // update — it flows through attachCampaign / detachCampaign instead.
  "campaignId",
]);

export async function createContent(tenantId, fields) {
  const {
    contentId: _ignoredId,
    links: providedLinks,
    ids: providedIds,
    campaignId,
    ...rest
  } = fields;
  const contentId = ulid();
  const now = new Date().toISOString();

  const item = {
    ...rest,
    ...contentKey(tenantId, contentId),
    entity: "Content",
    tenantId,
    contentId,
    // Seed links.url with the canonical URL at creation so cross-link
    // rewriting has something to match against. Per-platform link keys are
    // filled in as variants publish.
    links: { url: fields.canonicalUrl, ...(providedLinks ?? {}) },
    ids: providedIds ?? {},
    gsi1pk: contentListPartition(tenantId),
    gsi1sk: `${now}#${contentId}`,
    createdAt: now,
    updatedAt: now,
  };

  // contentId is a fresh ULID so a collision is effectively impossible; the
  // condition is hygiene. pk is shared across the tenant partition, so the
  // uniqueness guard is on sk (the full key identifies the item).
  const contentPut = {
    Put: {
      TableName: TABLE_NAME,
      Item: item,
      ConditionExpression: "attribute_not_exists(sk)",
    },
  };

  // No sponsorship attached: the unsponsored common case, a plain Put.
  if (!campaignId) {
    await ddb.send(new PutCommand(contentPut.Put));
    return item;
  }

  // A campaign hangs off this content piece. Write the content root and the
  // campaign's contentId/tenantId back-pointer atomically so the 1:1 link can
  // never be half-created. The campaign must exist and must not already be
  // attached to a different content piece.
  await assertCampaignAvailable(campaignId, tenantId);
  item.campaignId = campaignId;
  try {
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        contentPut,
        campaignBackPointerSet(campaignId, tenantId, contentId),
      ],
    }));
  } catch (err) {
    throw mapAttachConflict(err, campaignId);
  }
  return item;
}

// Reads the campaign and rejects a missing one (404), one owned by another
// tenant (404 — don't leak existence), or one already attached to another
// content piece (409), before an attach transaction runs, so the caller gets a
// precise error instead of an opaque TransactionCanceled.
//
// Ownership: campaigns are stamped with `tenantId` at creation via the content
// sponsorship flow. Legacy campaigns created before that carry no tenantId and
// are grandfathered (existence-only), matching the app's no-backfill stance.
async function assertCampaignAvailable(campaignId, tenantId, forContentId) {
  const campaign = await findCampaign(campaignId);
  if (!campaign) {
    throw new NotFoundError("Campaign", campaignId);
  }
  if (campaign.tenantId && campaign.tenantId !== tenantId) {
    throw new NotFoundError("Campaign", campaignId);
  }
  if (campaign.contentId && campaign.contentId !== forContentId) {
    throw new ConflictError(
      `Campaign ${campaignId} is already attached to another content piece`,
    );
  }
  return campaign;
}

// The TransactWrite Update that stamps the campaign row's back-pointer. The
// condition enforces the 1:1 invariant (the campaign is unattached, or already
// attached to this same content piece — idempotent re-attach).
function campaignBackPointerSet(campaignId, tenantId, contentId) {
  return {
    Update: {
      TableName: TABLE_NAME,
      Key: campaignKey(campaignId),
      UpdateExpression: "SET #contentId = :contentId, #tenantId = :tenantId",
      ExpressionAttributeNames: { "#contentId": "contentId", "#tenantId": "tenantId" },
      ExpressionAttributeValues: { ":contentId": contentId, ":tenantId": tenantId },
      ConditionExpression:
        "attribute_exists(pk) AND (attribute_not_exists(#contentId) OR #contentId = :contentId)",
    },
  };
}

function mapAttachConflict(err, campaignId) {
  if (err instanceof TransactionCanceledException || err?.name === "TransactionCanceledException") {
    return new ConflictError(
      `Campaign ${campaignId} could not be attached (it may already be linked to other content)`,
    );
  }
  return err;
}

export async function getContent(tenantId, contentId) {
  const result = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: contentKey(tenantId, contentId),
  }));
  if (!result.Item) {
    throw new NotFoundError("Content", contentId);
  }
  return result.Item;
}

// Returns the content (without throwing) for callers that need existence
// without a 404 — e.g. the publish trigger and campaign linkage.
export async function findContent(tenantId, contentId) {
  const result = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: contentKey(tenantId, contentId),
  }));
  return result.Item ?? null;
}

// Reads the vectorization state row (or null when the content has never been
// vectorized). Returns { contentHash, chunkCount, embeddedAt } when present.
export async function getContentVectorState(tenantId, contentId) {
  const result = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: contentVectorStateKey(tenantId, contentId),
  }));
  return result.Item ?? null;
}

// Records the content hash + chunk count after a successful (re)vectorization.
export async function putContentVectorState(tenantId, contentId, { contentHash, chunkCount }) {
  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      ...contentVectorStateKey(tenantId, contentId),
      entity: "ContentVectorIndex",
      tenantId,
      contentId,
      contentHash,
      chunkCount,
      embeddedAt: new Date().toISOString(),
    },
  }));
}

export async function listContentByTenant(tenantId, { limit, exclusiveStartKey, type, source, status } = {}) {
  // Optional server-side filters on the root attributes. Filters apply after
  // the GSI1 partition query, so paging still walks the newest-first index.
  const names = {};
  const values = { ":pk": contentListPartition(tenantId) };
  const filters = [];
  if (type !== undefined) {
    names["#type"] = "type";
    values[":type"] = type;
    filters.push("#type = :type");
  }
  if (source !== undefined) {
    names["#source"] = "source";
    values[":source"] = source;
    filters.push("#source = :source");
  }
  if (status !== undefined) {
    names["#status"] = "status";
    values[":status"] = status;
    filters.push("#status = :status");
  }

  const result = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: "GSI1",
    KeyConditionExpression: "gsi1pk = :pk",
    ...(filters.length > 0 ? { FilterExpression: filters.join(" AND "), ExpressionAttributeNames: names } : {}),
    ExpressionAttributeValues: values,
    ScanIndexForward: false, // newest first
    Limit: limit,
    ExclusiveStartKey: exclusiveStartKey,
  }));

  return {
    items: result.Items ?? [],
    lastEvaluatedKey: result.LastEvaluatedKey,
  };
}

// Builds the SET/REMOVE expression for a partial content update.
function buildContentUpdateExpression(fields) {
  const names = { "#updatedAt": "updatedAt" };
  const values = { ":updatedAt": new Date().toISOString() };
  const setClauses = ["#updatedAt = :updatedAt"];
  const removeClauses = [];

  for (const [key, value] of Object.entries(fields)) {
    if (PROTECTED_UPDATE_FIELDS.has(key)) continue;
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

  // Keep links.url in lockstep with canonicalUrl. Per-platform link keys
  // are owned by the publish flow and are intentionally left untouched.
  if (typeof fields.canonicalUrl === "string") {
    names["#links"] = "links";
    names["#url"] = "url";
    values[":canonicalUrl"] = fields.canonicalUrl;
    setClauses.push("#links.#url = :canonicalUrl");
  }

  let updateExpression = `SET ${setClauses.join(", ")}`;
  if (removeClauses.length > 0) {
    updateExpression += ` REMOVE ${removeClauses.join(", ")}`;
  }

  return {
    UpdateExpression: updateExpression,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };
}

export async function updateContent(tenantId, contentId, fields) {
  try {
    const result = await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: contentKey(tenantId, contentId),
      ...buildContentUpdateExpression(fields),
      ConditionExpression: "attribute_exists(sk)",
      ReturnValues: "ALL_NEW",
    }));
    return result.Attributes;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException || err?.name === "ConditionalCheckFailedException") {
      throw new NotFoundError("Content", contentId);
    }
    throw err;
  }
}

// Attaches an existing campaign to a content piece (the sponsorship hangs off
// the content). Bidirectional and atomic: the content root gets `campaignId`
// and the campaign row gets `contentId`/`tenantId`, guarded so neither side
// can already belong to a different partner (1:1). Idempotent for the same
// pair. Returns the updated content root.
export async function attachCampaign(tenantId, contentId, campaignId) {
  await getContent(tenantId, contentId); // 404 if the content doesn't exist
  await assertCampaignAvailable(campaignId, tenantId, contentId);

  try {
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: TABLE_NAME,
            Key: contentKey(tenantId, contentId),
            UpdateExpression: "SET #campaignId = :campaignId, #updatedAt = :now",
            ExpressionAttributeNames: { "#campaignId": "campaignId", "#updatedAt": "updatedAt" },
            ExpressionAttributeValues: { ":campaignId": campaignId, ":now": new Date().toISOString() },
            ConditionExpression:
              "attribute_exists(sk) AND (attribute_not_exists(#campaignId) OR #campaignId = :campaignId)",
          },
        },
        campaignBackPointerSet(campaignId, tenantId, contentId),
      ],
    }));
  } catch (err) {
    throw mapAttachConflict(err, campaignId);
  }

  return getContent(tenantId, contentId);
}

// Detaches the campaign from a content piece, leaving an unsponsored piece.
// The campaign itself survives — it just loses its content back-pointer.
// Idempotent: a piece with no attached campaign is returned unchanged.
//
// The content side is cleared first and unconditionally (beyond existence):
// clearing the sponsorship is the user-visible action and must succeed even
// for a legacy link created before the back-pointer existed, where the
// campaign row carries no `contentId`. The campaign back-pointer is then
// cleared best-effort (see clearCampaignBackPointer).
export async function detachCampaign(tenantId, contentId) {
  const content = await getContent(tenantId, contentId);
  const campaignId = content.campaignId;
  if (!campaignId) {
    return content;
  }

  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: contentKey(tenantId, contentId),
    UpdateExpression: "REMOVE #campaignId SET #updatedAt = :now",
    ExpressionAttributeNames: { "#campaignId": "campaignId", "#updatedAt": "updatedAt" },
    ExpressionAttributeValues: { ":now": new Date().toISOString() },
    ConditionExpression: "attribute_exists(sk)",
  }));

  await clearCampaignBackPointer(campaignId, contentId);

  return getContent(tenantId, contentId);
}

// Clears a campaign's content back-pointer, guarded so a campaign since
// re-linked to different content is left alone. A legacy campaign that never
// had a back-pointer (or one already cleared) simply has nothing to remove and
// the guard's ConditionalCheckFailed is swallowed — the content side has
// already been detached, so the operation still succeeds overall.
async function clearCampaignBackPointer(campaignId, contentId) {
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: campaignKey(campaignId),
      UpdateExpression: "REMOVE #contentId, #tenantId",
      ExpressionAttributeNames: { "#contentId": "contentId", "#tenantId": "tenantId" },
      ExpressionAttributeValues: { ":contentId": contentId },
      ConditionExpression: "#contentId = :contentId",
    }));
  } catch (err) {
    if (!(err instanceof ConditionalCheckFailedException || err?.name === "ConditionalCheckFailedException")) {
      throw err;
    }
  }
}

// Deletes the content and all of its child rows (publish variants, stats,
// vector state) in one sweep. begins_with(sk, "CONTENT#{contentId}") matches
// the root and its children; ULIDs are fixed-length so it never spills into
// another content item.
export async function deleteContent(tenantId, contentId) {
  const found = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: {
      ":pk": tenantPartition(tenantId),
      ":prefix": `CONTENT#${contentId}`,
    },
    // campaignId rides along so we can clear the campaign's back-pointer when
    // a sponsored piece is deleted (it lives in a different partition and so
    // isn't swept by the cascade below).
    ProjectionExpression: "pk, sk, campaignId",
  }));

  const items = found.Items ?? [];
  const root = items.find((it) => it.sk === `CONTENT#${contentId}`);
  if (!root) {
    throw new NotFoundError("Content", contentId);
  }

  const keys = items.map((it) => ({ pk: it.pk, sk: it.sk }));

  for (let i = 0; i < keys.length; i += 25) {
    const chunk = keys.slice(i, i + 25);
    await ddb.send(new BatchWriteCommand({
      RequestItems: {
        [TABLE_NAME]: chunk.map((key) => ({ DeleteRequest: { Key: key } })),
      },
    }));
  }

  // Clear the attached campaign's dangling content back-pointer, if any (it
  // lives in a different partition, so the cascade above doesn't touch it).
  if (root.campaignId) {
    await clearCampaignBackPointer(root.campaignId, contentId);
  }

  return { deleted: keys.length };
}

// ---------------------------------------------------------------------
// Publish variant + stats writers (used by the publish/analytics flows)
// ---------------------------------------------------------------------

// Upserts a per-platform publish variant row for a piece of content.
export async function putPublishVariant(tenantId, contentId, platform, fields = {}) {
  const item = {
    ...fields,
    ...publishVariantKey(tenantId, contentId, platform),
    entity: "ContentPublish",
    tenantId,
    contentId,
    platform,
    updatedAt: new Date().toISOString(),
  };
  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
  return item;
}

// Reads the per-platform publish variants for a piece of content.
export async function listPublishVariants(tenantId, contentId) {
  const result = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: {
      ":pk": tenantPartition(tenantId),
      ":prefix": `CONTENT#${contentId}#PUBLISH#`,
    },
  }));
  return result.Items ?? [];
}

// Writes a daily stats snapshot for one platform of a piece of content. Same-
// day rewrites overwrite — only the last write of the day is kept.
export async function putStatsSnapshot(tenantId, contentId, platform, date, fields = {}) {
  const item = {
    ...fields,
    ...statsKey(tenantId, contentId, platform, date),
    entity: "ContentStats",
    tenantId,
    contentId,
    platform,
    date,
    capturedAt: new Date().toISOString(),
  };
  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
  return item;
}

// Reads every daily stats snapshot for a piece of content, across platforms,
// oldest first. Personal scale, so all pages are consumed. Used by the content
// analytics view to plot per-platform daily series.
export async function listContentStats(tenantId, contentId) {
  const items = [];
  let exclusiveStartKey;
  do {
    const result = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":pk": tenantPartition(tenantId),
        ":prefix": `CONTENT#${contentId}#STATS#`,
      },
      ExclusiveStartKey: exclusiveStartKey,
    }));
    for (const it of result.Items ?? []) items.push(it);
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  items.sort((a, b) => `${a.platform}#${a.date}`.localeCompare(`${b.platform}#${b.date}`));
  return items;
}
