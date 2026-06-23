import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { TABLE_NAME, ddb } from "../services/ddb.mjs";
import { NotFoundError } from "../services/errors.mjs";

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
  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: item,
    ConditionExpression: "attribute_not_exists(sk)",
  }));

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

export async function updateBlog(tenantId, blogId, fields) {
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

  try {
    const result = await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: blogKey(tenantId, blogId),
      UpdateExpression: updateExpression,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
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

// Deletes the blog and all of its child rows (copies, runs, snapshots) in
// one sweep. begins_with(sk, "BLOG#{blogId}") matches the root and its
// children; ULIDs are fixed-length so it never spills into another blog.
// The campaign ref (sk=CAMPAIGNREF#...) uses a different prefix and is
// cleaned up by the campaign-linkage flow.
export async function deleteBlog(tenantId, blogId) {
  const found = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: {
      ":pk": tenantPartition(tenantId),
      ":prefix": `BLOG#${blogId}`,
    },
    ProjectionExpression: "pk, sk",
  }));

  const items = found.Items ?? [];
  if (!items.some((it) => it.sk === `BLOG#${blogId}`)) {
    throw new NotFoundError("Blog", blogId);
  }

  for (let i = 0; i < items.length; i += 25) {
    const chunk = items.slice(i, i + 25);
    await ddb.send(new BatchWriteCommand({
      RequestItems: {
        [TABLE_NAME]: chunk.map((it) => ({
          DeleteRequest: { Key: { pk: it.pk, sk: it.sk } },
        })),
      },
    }));
  }

  return { deleted: items.length };
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
