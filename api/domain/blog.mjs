import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { TABLE_NAME, ddb } from "../services/ddb.mjs";
import { NotFoundError } from "../services/errors.mjs";
import { findCampaign } from "./campaign.mjs";

// Blog records are tenant-scoped by partition. Everything for a tenant
// lives under pk = TENANT#{tenantId} where tenantId is the Cognito sub
// from the authorizer (never the client). This gives structural
// isolation: a handler can only ever query its own tenant's partition.
// See docs/blog-tracking-data-model.md.
//
//   Blog root        pk=TENANT#{tenantId}  sk=BLOG#{blogId}
//   Crosspost copy   pk=TENANT#{tenantId}  sk=BLOG#{blogId}#CROSSPOST#{platform}
//   Crosspost run    pk=TENANT#{tenantId}  sk=BLOG#{blogId}#RUN#{runId}
//   View snapshot    pk=TENANT#{tenantId}  sk=BLOG#{blogId}#VIEWCOUNT#{date}
//   Campaign ref     pk=TENANT#{tenantId}  sk=CAMPAIGNREF#{campaignId}#{blogId}
//
// The blog ROOT also writes gsi1pk = "TENANT#{tenantId}#BLOG" with
// gsi1sk = "{createdAt}#{blogId}", so listBlogsByTenant (and the
// cross-link catalog) is a clean Query against GSI1 that returns roots
// only — child rows carry no GSI1 keys.

export function tenantPartition(tenantId) {
  return `TENANT#${tenantId}`;
}

function blogListPartition(tenantId) {
  return `TENANT#${tenantId}#BLOG`;
}

export function blogKey(tenantId, blogId) {
  return { pk: tenantPartition(tenantId), sk: `BLOG#${blogId}` };
}

// Child-key helpers, exported for the cross-post and analytics durable
// functions so the key shapes live in one place.
export function crosspostCopyKey(tenantId, blogId, platform) {
  return { pk: tenantPartition(tenantId), sk: `BLOG#${blogId}#CROSSPOST#${platform}` };
}

export function crosspostRunKey(tenantId, blogId, runId) {
  return { pk: tenantPartition(tenantId), sk: `BLOG#${blogId}#RUN#${runId}` };
}

export function viewSnapshotKey(tenantId, blogId, date) {
  return { pk: tenantPartition(tenantId), sk: `BLOG#${blogId}#VIEWCOUNT#${date}` };
}

export function campaignRefKey(tenantId, campaignId, blogId) {
  return { pk: tenantPartition(tenantId), sk: `CAMPAIGNREF#${campaignId}#${blogId}` };
}

function campaignRefItem(tenantId, campaignId, blogId, createdAt) {
  return {
    ...campaignRefKey(tenantId, campaignId, blogId),
    entity: "BlogCampaignRef",
    tenantId,
    blogId,
    campaignId,
    createdAt,
  };
}

// Guards a campaign reference: the campaign must exist. Campaigns are not
// tenant-scoped yet, so this only checks existence (not ownership); when
// campaigns move to the shared pool this should also verify the tenant.
async function assertCampaignExists(campaignId) {
  const campaign = await findCampaign(campaignId);
  if (!campaign) {
    throw new NotFoundError("Campaign", campaignId);
  }
}

// Attributes the partial update must never touch: keys, identity,
// immutable metadata, and the maps the cross-post flow owns. links/ids
// are excluded so a blog edit can't clobber the per-platform copy URLs
// and ids written during cross-posting. canonicalUrl IS editable and is
// mirrored into links.url (see updateBlog).
const PROTECTED_UPDATE_FIELDS = new Set([
  "pk",
  "sk",
  "blogId",
  "tenantId",
  "entity",
  "createdAt",
  "gsi1pk",
  "gsi1sk",
  "links",
  "ids",
]);

export async function createBlog(tenantId, fields) {
  const { blogId: _ignoredId, links: providedLinks, ids: providedIds, ...rest } = fields;
  const blogId = ulid();
  const now = new Date().toISOString();

  const item = {
    ...rest,
    ...blogKey(tenantId, blogId),
    entity: "Blog",
    tenantId,
    blogId,
    // Seed links.url with the canonical URL at creation so parse-blog's
    // cross-link rewriting has something to match against (a legacy gap).
    // Per-platform link keys are filled in as copies publish.
    links: { url: fields.canonicalUrl, ...(providedLinks ?? {}) },
    ids: providedIds ?? {},
    gsi1pk: blogListPartition(tenantId),
    gsi1sk: `${now}#${blogId}`,
    createdAt: now,
    updatedAt: now,
  };

  // blogId is a fresh ULID so a collision is effectively impossible; the
  // condition is hygiene. pk is shared across the tenant partition, so the
  // uniqueness guard is on sk (the full key identifies the item).
  const blogPut = {
    Put: {
      TableName: TABLE_NAME,
      Item: item,
      ConditionExpression: "attribute_not_exists(sk)",
    },
  };

  // When the blog references a campaign, write the reverse-lookup ref row
  // atomically with the blog so a campaign's blog list can never point at a
  // half-created blog. The campaign must exist.
  if (item.campaignId) {
    await assertCampaignExists(item.campaignId);
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        blogPut,
        { Put: { TableName: TABLE_NAME, Item: campaignRefItem(tenantId, item.campaignId, blogId, now) } },
      ],
    }));
  } else {
    await ddb.send(new PutCommand(blogPut.Put));
  }

  return item;
}

export async function getBlog(tenantId, blogId) {
  const result = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: blogKey(tenantId, blogId),
  }));
  if (!result.Item) {
    throw new NotFoundError("Blog", blogId);
  }
  return result.Item;
}

// Returns the blog (without throwing) for callers that need existence
// without a 404 — e.g. the cross-post trigger and campaign linkage.
export async function findBlog(tenantId, blogId) {
  const result = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: blogKey(tenantId, blogId),
  }));
  return result.Item ?? null;
}

export async function listBlogsByTenant(tenantId, { limit, exclusiveStartKey } = {}) {
  const result = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: "GSI1",
    KeyConditionExpression: "gsi1pk = :pk",
    ExpressionAttributeValues: { ":pk": blogListPartition(tenantId) },
    ScanIndexForward: false, // newest first
    Limit: limit,
    ExclusiveStartKey: exclusiveStartKey,
  }));

  return {
    items: result.Items ?? [],
    lastEvaluatedKey: result.LastEvaluatedKey,
  };
}

// Builds the SET/REMOVE expression for a partial blog update, shared by the
// plain update and the campaign-aware transactional update.
function buildBlogUpdateExpression(fields) {
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
  // (links.dev/medium/hashnode) are owned by the cross-post flow and are
  // intentionally left untouched.
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

export async function updateBlog(tenantId, blogId, fields) {
  // A change to campaignId also moves the reverse-lookup ref row, so it
  // goes through a transaction that updates the blog and swaps the ref
  // together.
  if ("campaignId" in fields) {
    return updateBlogWithCampaign(tenantId, blogId, fields);
  }

  try {
    const result = await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: blogKey(tenantId, blogId),
      ...buildBlogUpdateExpression(fields),
      ConditionExpression: "attribute_exists(sk)",
      ReturnValues: "ALL_NEW",
    }));
    return result.Attributes;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException || err?.name === "ConditionalCheckFailedException") {
      throw new NotFoundError("Blog", blogId);
    }
    throw err;
  }
}

async function updateBlogWithCampaign(tenantId, blogId, fields) {
  // Need the old campaignId to know which ref row to remove. getBlog throws
  // NotFound when the blog is missing.
  const existing = await getBlog(tenantId, blogId);
  const oldCampaignId = existing.campaignId ?? null;
  const newCampaignId = fields.campaignId ?? null; // null clears the link

  if (newCampaignId && newCampaignId !== oldCampaignId) {
    await assertCampaignExists(newCampaignId);
  }

  const transactItems = [
    {
      Update: {
        TableName: TABLE_NAME,
        Key: blogKey(tenantId, blogId),
        ...buildBlogUpdateExpression(fields),
        ConditionExpression: "attribute_exists(sk)",
      },
    },
  ];
  if (oldCampaignId && oldCampaignId !== newCampaignId) {
    transactItems.push({ Delete: { TableName: TABLE_NAME, Key: campaignRefKey(tenantId, oldCampaignId, blogId) } });
  }
  if (newCampaignId && newCampaignId !== oldCampaignId) {
    transactItems.push({
      Put: { TableName: TABLE_NAME, Item: campaignRefItem(tenantId, newCampaignId, blogId, new Date().toISOString()) },
    });
  }

  await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));
  return getBlog(tenantId, blogId);
}

// Deletes the blog and all of its child rows (copies, runs, snapshots) in
// one sweep, plus the campaign ref row when the blog is linked.
// begins_with(sk, "BLOG#{blogId}") matches the root and its children;
// ULIDs are fixed-length so it never spills into another blog. The campaign
// ref uses a different prefix, so it is added to the delete batch explicitly
// using the root's campaignId.
export async function deleteBlog(tenantId, blogId) {
  const found = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: {
      ":pk": tenantPartition(tenantId),
      ":prefix": `BLOG#${blogId}`,
    },
    ProjectionExpression: "pk, sk, campaignId",
  }));

  const items = found.Items ?? [];
  const root = items.find((it) => it.sk === `BLOG#${blogId}`);
  if (!root) {
    throw new NotFoundError("Blog", blogId);
  }

  const keys = items.map((it) => ({ pk: it.pk, sk: it.sk }));
  if (root.campaignId) {
    keys.push(campaignRefKey(tenantId, root.campaignId, blogId));
  }

  for (let i = 0; i < keys.length; i += 25) {
    const chunk = keys.slice(i, i + 25);
    await ddb.send(new BatchWriteCommand({
      RequestItems: {
        [TABLE_NAME]: chunk.map((key) => ({ DeleteRequest: { Key: key } })),
      },
    }));
  }

  return { deleted: keys.length };
}

// Lists the blogs a campaign references, newest first. Reads the ref rows
// (cheap), then batch-gets the blog roots so the data is fresh rather than
// denormalized onto the ref. Campaigns reference few blogs, so a single
// BatchGet (<=100 keys) is sufficient.
export async function listBlogsForCampaign(tenantId, campaignId) {
  const refs = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: {
      ":pk": tenantPartition(tenantId),
      ":prefix": `CAMPAIGNREF#${campaignId}#`,
    },
  }));

  const blogIds = (refs.Items ?? []).map((r) => r.blogId).filter(Boolean);
  if (blogIds.length === 0) return [];

  const result = await ddb.send(new BatchGetCommand({
    RequestItems: {
      [TABLE_NAME]: { Keys: blogIds.map((id) => blogKey(tenantId, id)) },
    },
  }));

  const blogs = result.Responses?.[TABLE_NAME] ?? [];
  return blogs.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

// Single-purpose delete of just the blog root, used where a cascade is not
// wanted. Most callers want deleteBlog above.
export async function deleteBlogRoot(tenantId, blogId) {
  try {
    await ddb.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: blogKey(tenantId, blogId),
      ConditionExpression: "attribute_exists(sk)",
    }));
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException || err?.name === "ConditionalCheckFailedException") {
      throw new NotFoundError("Blog", blogId);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------
// Cross-post run + copy writers (used by the crosspost durable function)
// ---------------------------------------------------------------------

// Marks a cross-post run in progress and seeds a per-platform copy row so
// the status endpoint can show "pending"/"scheduled" before publishing.
// `platforms` is [{ platform, delaySeconds }].
//
// Re-trigger dedup: a platform whose copy already `succeeded` (from an
// earlier run) is NOT reset — its copy is left intact and it's returned in
// `alreadySucceeded` so the durable function skips republishing it. Returns
// { alreadySucceeded: { <platform>: { url, id, slug } } }.
export async function startCrosspostRun(tenantId, blogId, { runId, platforms }) {
  const now = new Date().toISOString();

  const existing = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: {
      ":pk": tenantPartition(tenantId),
      ":prefix": `BLOG#${blogId}#CROSSPOST#`,
    },
  }));

  const alreadySucceeded = {};
  for (const copy of existing.Items ?? []) {
    if (copy.status === "succeeded") {
      alreadySucceeded[copy.platform] = { url: copy.url, id: copy.id, slug: copy.slug };
    }
  }

  const run = {
    ...crosspostRunKey(tenantId, blogId, runId),
    entity: "BlogCrosspostRun",
    tenantId,
    blogId,
    runId,
    status: "in progress",
    platforms: platforms.map((p) => p.platform),
    startedAt: now,
  };

  // Seed copies only for platforms not already succeeded, so a re-trigger
  // never resets a good copy back to pending.
  const copies = platforms
    .filter((p) => !alreadySucceeded[p.platform])
    .map((p) => {
      const scheduled = p.delaySeconds > 0;
      return {
        ...crosspostCopyKey(tenantId, blogId, p.platform),
        entity: "BlogCrosspost",
        tenantId,
        blogId,
        platform: p.platform,
        status: scheduled ? "scheduled" : "pending",
        runId,
        ...(scheduled ? { scheduledFor: new Date(Date.now() + p.delaySeconds * 1000).toISOString() } : {}),
      };
    });

  const items = [run, ...copies];
  for (let i = 0; i < items.length; i += 25) {
    const chunk = items.slice(i, i + 25);
    await ddb.send(new BatchWriteCommand({
      RequestItems: { [TABLE_NAME]: chunk.map((Item) => ({ PutRequest: { Item } })) },
    }));
  }

  return { alreadySucceeded };
}

// Records the outcome of one platform publish. On success it updates the
// copy row and mirrors the native URL/id onto the blog root (links.<p> /
// ids.<p>) in one transaction. On failure it just marks the copy failed.
export async function recordCrosspostResult(tenantId, blogId, platform, { runId, status, url, id, slug, error }) {
  const now = new Date().toISOString();

  if (status !== "succeeded") {
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: crosspostCopyKey(tenantId, blogId, platform),
      UpdateExpression: "SET #status = :status, #error = :error, #runId = :runId, #attemptedAt = :now",
      ExpressionAttributeNames: { "#status": "status", "#error": "error", "#runId": "runId", "#attemptedAt": "attemptedAt" },
      ExpressionAttributeValues: { ":status": status, ":error": error ?? "unknown error", ":runId": runId, ":now": now },
    }));
    return;
  }

  // Success: build the copy-update clauses dynamically so undefined fields
  // aren't referenced in the expression.
  const names = { "#status": "status", "#publishedAt": "publishedAt", "#runId": "runId", "#error": "error" };
  const values = { ":status": "succeeded", ":now": now, ":runId": runId };
  const setClauses = ["#status = :status", "#publishedAt = :now", "#runId = :runId"];
  if (url !== undefined) {
    names["#url"] = "url";
    values[":url"] = url;
    setClauses.push("#url = :url");
  }
  if (id !== undefined) {
    names["#cid"] = "id";
    values[":id"] = id;
    setClauses.push("#cid = :id");
  }
  if (slug !== undefined) {
    names["#slug"] = "slug";
    values[":slug"] = slug;
    setClauses.push("#slug = :slug");
  }
  const copyUpdate = {
    Update: {
      TableName: TABLE_NAME,
      Key: crosspostCopyKey(tenantId, blogId, platform),
      UpdateExpression: `SET ${setClauses.join(", ")} REMOVE #error`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    },
  };

  // Mirror onto the blog root: links.<platform> = url, ids.<platform> = id.
  const rootNames = { "#updatedAt": "updatedAt", "#p": platform };
  const rootValues = { ":now": now };
  const rootSet = ["#updatedAt = :now"];
  if (url !== undefined) {
    rootNames["#links"] = "links";
    rootValues[":url"] = url;
    rootSet.push("#links.#p = :url");
  }
  if (id !== undefined) {
    rootNames["#ids"] = "ids";
    rootValues[":id"] = id;
    rootSet.push("#ids.#p = :id");
  }
  const rootUpdate = {
    Update: {
      TableName: TABLE_NAME,
      Key: blogKey(tenantId, blogId),
      UpdateExpression: `SET ${rootSet.join(", ")}`,
      ExpressionAttributeNames: rootNames,
      ExpressionAttributeValues: rootValues,
    },
  };

  await ddb.send(new TransactWriteCommand({ TransactItems: [copyUpdate, rootUpdate] }));
}

// Finalizes the run record with the overall status.
export async function completeCrosspostRun(tenantId, blogId, runId, status) {
  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: crosspostRunKey(tenantId, blogId, runId),
    UpdateExpression: "SET #status = :status, #completedAt = :now",
    ExpressionAttributeNames: { "#status": "status", "#completedAt": "completedAt" },
    ExpressionAttributeValues: { ":status": status, ":now": new Date().toISOString() },
  }));
}

// Reads the cross-post state for the status endpoint: the per-platform
// copies plus a run row.
//
// When `runId` is given (the client polling the run it just started), the
// run is read by that exact id and the copies are filtered to it. This
// correlates the poll to the new run: until the durable function writes
// its start-run row, the run reads as null and no stale previous-run copies
// leak through. Without `runId`, it returns the most recent run + all
// copies (the blog's general "current state" view).
export async function getCrosspostStatus(tenantId, blogId, { runId } = {}) {
  const pk = tenantPartition(tenantId);

  const copiesPromise = ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":pk": pk, ":prefix": `BLOG#${blogId}#CROSSPOST#` },
  }));

  const runPromise = runId
    ? ddb.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: crosspostRunKey(tenantId, blogId, runId),
    })).then((r) => r.Item ?? null)
    : ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": pk, ":prefix": `BLOG#${blogId}#RUN#` },
      ScanIndexForward: false,
      Limit: 1,
    })).then((r) => r.Items?.[0] ?? null);

  const [copiesResult, run] = await Promise.all([copiesPromise, runPromise]);

  let copies = copiesResult.Items ?? [];
  if (runId) {
    copies = copies.filter((c) => c.runId === runId);
  }

  return { copies, run };
}
