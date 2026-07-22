import {
  BatchWriteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { TABLE_NAME, ddb, isConditionalCheckFailed } from "../services/ddb.mjs";
import { NotFoundError } from "../services/errors.mjs";
import { tenantPartition } from "./blog.mjs";
import { anchorSuggestion, isSuggestionAnchored, reanchorSuggestion } from "../services/suggestion-offsets.mjs";

// Persistence for the content review feature: a Review run and the anchored
// Suggestions it produced. Both hang off a piece of Content as child rows so
// they share its tenant partition and are swept by deleteContent's
// begins_with(sk, "CONTENT#{contentId}") cascade for free:
//
//   Review       pk=TENANT#{tenantId}  sk=CONTENT#{contentId}#REVIEW#{reviewId}
//   Suggestion   pk=TENANT#{tenantId}  sk=CONTENT#{contentId}#SUGGESTION#{id}
//
// Child rows carry no GSI1 keys (like every other CONTENT child), so the
// content-list index never sees them. Suggestion location/anchoring lives in
// services/suggestion-offsets.mjs; this module owns storage and lifecycle.

// Terminal-ish cleanup for abandoned reviews: rows self-expire via the table's
// `expiresAt` TTL so a review a creator never finishes doesn't linger forever.
// Live suggestions on an active draft are refreshed well within this window;
// the cascade delete is the primary cleanup, this is just a backstop.
const ROW_TTL_DAYS = 30;

export const REVIEW_STATUSES = ["pending", "running", "succeeded", "failed"];
export const SUGGESTION_STATUSES = ["pending", "accepted", "rejected", "dismissed", "skipped"];

function ttlEpoch(days = ROW_TTL_DAYS) {
  return Math.floor(Date.now() / 1000) + days * 86_400;
}

export function reviewKey(tenantId, contentId, reviewId) {
  return { pk: tenantPartition(tenantId), sk: `CONTENT#${contentId}#REVIEW#${reviewId}` };
}

export function suggestionKey(tenantId, contentId, suggestionId) {
  return { pk: tenantPartition(tenantId), sk: `CONTENT#${contentId}#SUGGESTION#${suggestionId}` };
}

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

// Opens a review run in the `pending` state. `contentVersion` stamps which body
// snapshot the run is analysing (we use the content root's updatedAt) so the
// suggestions it later records, and any revalidation, agree on the baseline.
export async function createReview(tenantId, contentId, { contentVersion }) {
  const reviewId = ulid();
  const now = new Date().toISOString();
  const item = {
    ...reviewKey(tenantId, contentId, reviewId),
    entity: "ContentReview",
    tenantId,
    contentId,
    reviewId,
    status: "pending",
    contentVersion: contentVersion ?? null,
    createdAt: now,
    updatedAt: now,
    expiresAt: ttlEpoch(),
  };
  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: item,
    ConditionExpression: "attribute_not_exists(sk)",
  }));
  return item;
}

export async function getReview(tenantId, contentId, reviewId) {
  const result = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: reviewKey(tenantId, contentId, reviewId),
  }));
  if (!result.Item) {
    throw new NotFoundError("Review", reviewId);
  }
  return result.Item;
}

// Atomically claims a pending review for processing (pending -> running),
// returning true on success and false when it was already claimed or is no
// longer pending. This is the idempotency gate for the orchestrator: the
// "Start Content Review" event is delivered at-least-once (EventBridge/Lambda
// can redeliver or replay), and without a claim a duplicate run would record a
// second set of suggestions (recordSuggestions only dedupes within one batch).
// The first delivery wins the claim and runs; every later one gets false and
// no-ops.
export async function claimReview(tenantId, contentId, reviewId) {
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: reviewKey(tenantId, contentId, reviewId),
      UpdateExpression: "SET #status = :running, #updatedAt = :now",
      ExpressionAttributeNames: { "#status": "status", "#updatedAt": "updatedAt" },
      ExpressionAttributeValues: {
        ":running": "running",
        ":now": new Date().toISOString(),
        ":pending": "pending",
      },
      ConditionExpression: "attribute_exists(sk) AND #status = :pending",
    }));
    return true;
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      return false;
    }
    throw err;
  }
}

// Marks a review terminal (succeeded/failed) and attaches the summarizer output.
// Called by the review engine when the lenses finish; a no-op-safe UpdateCommand
// so a late/duplicate completion can't error.
export async function completeReview(tenantId, contentId, reviewId, { status, summary, lenses }) {
  const result = await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: reviewKey(tenantId, contentId, reviewId),
    UpdateExpression: "SET #status = :status, #summary = :summary, #lenses = :lenses, #updatedAt = :now",
    ExpressionAttributeNames: {
      "#status": "status",
      "#summary": "summary",
      "#lenses": "lenses",
      "#updatedAt": "updatedAt",
    },
    ExpressionAttributeValues: {
      ":status": status,
      ":summary": summary ?? null,
      ":lenses": lenses ?? null,
      ":now": new Date().toISOString(),
    },
    ConditionExpression: "attribute_exists(sk)",
    ReturnValues: "ALL_NEW",
  }));
  return result.Attributes;
}

// The most recent review for a piece of content (newest first by ULID reviewId).
// Powers the "latest summary" the suggestions list carries.
export async function getLatestReview(tenantId, contentId) {
  const result = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: {
      ":pk": tenantPartition(tenantId),
      ":prefix": `CONTENT#${contentId}#REVIEW#`,
    },
    ScanIndexForward: false,
    Limit: 1,
  }));
  return result.Items?.[0] ?? null;
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

// Anchors and persists a batch of raw model suggestions against `body`. Each is
// re-anchored (offsets re-derived from the text, context window + hash captured)
// via anchorSuggestion; suggestions whose text isn't in the body are dropped,
// and same-location duplicates (identical contextHash) are collapsed to the
// first — the model, and multiple lenses, routinely flag the same span. Returns
// the suggestions actually written. `body` is the content_markdown the review
// ran against; `contentVersion` is the matching baseline stamp.
export async function recordSuggestions(tenantId, contentId, { reviewId, contentVersion, body, suggestions }) {
  const now = new Date().toISOString();
  const seen = new Set();
  const items = [];

  for (const raw of suggestions ?? []) {
    const anchor = anchorSuggestion(body, raw);
    if (!anchor) continue; // text not found in the body — stale/hallucinated span
    if (seen.has(anchor.contextHash)) continue; // same place flagged twice
    seen.add(anchor.contextHash);

    const suggestionId = ulid();
    items.push({
      ...suggestionKey(tenantId, contentId, suggestionId),
      entity: "ContentSuggestion",
      tenantId,
      contentId,
      suggestionId,
      reviewId: reviewId ?? null,
      status: "pending",
      type: raw.type,
      priority: raw.priority ?? "medium",
      reason: raw.reason ?? "",
      replaceWith: typeof raw.replaceWith === "string" ? raw.replaceWith : "",
      ...anchor,
      contentVersion: contentVersion ?? null,
      createdAt: now,
      expiresAt: ttlEpoch(),
    });
  }

  for (let i = 0; i < items.length; i += 25) {
    const chunk = items.slice(i, i + 25);
    await ddb.send(new BatchWriteCommand({
      RequestItems: {
        [TABLE_NAME]: chunk.map((Item) => ({ PutRequest: { Item } })),
      },
    }));
  }

  return items;
}

// Lists a content piece's suggestions, pending by default. Ordered by the ULID
// suggestionId (creation order) so the editor walks them front-to-back.
export async function listSuggestions(tenantId, contentId, { status = "pending" } = {}) {
  const result = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ...(status
      ? {
          FilterExpression: "#status = :status",
          ExpressionAttributeNames: { "#status": "status" },
        }
      : {}),
    ExpressionAttributeValues: {
      ":pk": tenantPartition(tenantId),
      ":prefix": `CONTENT#${contentId}#SUGGESTION#`,
      ...(status ? { ":status": status } : {}),
    },
  }));
  return result.Items ?? [];
}

// Transitions a suggestion (accepted / rejected / dismissed). Guarded so acting
// on a missing suggestion is a clean 404 rather than a silent write. Returns the
// updated row.
export async function updateSuggestionStatus(tenantId, contentId, suggestionId, status) {
  try {
    const result = await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: suggestionKey(tenantId, contentId, suggestionId),
      UpdateExpression: "SET #status = :status, #resolvedAt = :now",
      ExpressionAttributeNames: { "#status": "status", "#resolvedAt": "resolvedAt" },
      ExpressionAttributeValues: { ":status": status, ":now": new Date().toISOString() },
      ConditionExpression: "attribute_exists(sk)",
      ReturnValues: "ALL_NEW",
    }));
    return result.Attributes;
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      throw new NotFoundError("Suggestion", suggestionId);
    }
    throw err;
  }
}

// Re-checks every pending suggestion against a new body after the content was
// edited. Suggestions whose anchor+context still appear intact survive
// (re-stamped to the new contentVersion); those whose span the edit removed or
// rewrote are marked `skipped` so they leave the editor without being counted as
// rejected. Returns { kept, skipped }. Best-effort per row so one bad write
// doesn't strand the rest.
export async function revalidateSuggestions(tenantId, contentId, newBody, { contentVersion } = {}) {
  const pending = await listSuggestions(tenantId, contentId, { status: "pending" });
  let kept = 0;
  let skipped = 0;

  for (const s of pending) {
    const stillValid = isSuggestionAnchored(newBody, s);
    try {
      if (stillValid) {
        // Re-locate the anchor in the new body and persist the fresh offsets +
        // context. An edit *before* an otherwise-intact span shifts its
        // position, so keeping only contentVersion would leave startOffset/
        // endOffset pointing at stale positions and a later
        // GET /suggestions would highlight the wrong span. Fall back to the
        // stored anchor if re-location somehow fails.
        const a = reanchorSuggestion(newBody, s) ?? {};
        await ddb.send(new UpdateCommand({
          TableName: TABLE_NAME,
          Key: suggestionKey(tenantId, contentId, s.suggestionId),
          UpdateExpression:
            "SET #contentVersion = :v, #startOffset = :start, #endOffset = :end, #anchorText = :anchor, #contextBefore = :cb, #contextAfter = :ca, #contextHash = :ch",
          ExpressionAttributeNames: {
            "#contentVersion": "contentVersion",
            "#startOffset": "startOffset",
            "#endOffset": "endOffset",
            "#anchorText": "anchorText",
            "#contextBefore": "contextBefore",
            "#contextAfter": "contextAfter",
            "#contextHash": "contextHash",
          },
          ExpressionAttributeValues: {
            ":v": contentVersion ?? s.contentVersion ?? null,
            ":start": a.startOffset ?? s.startOffset,
            ":end": a.endOffset ?? s.endOffset,
            ":anchor": a.anchorText ?? s.anchorText,
            ":cb": a.contextBefore ?? s.contextBefore,
            ":ca": a.contextAfter ?? s.contextAfter,
            ":ch": a.contextHash ?? s.contextHash,
          },
          ConditionExpression: "attribute_exists(sk)",
        }));
        kept += 1;
      } else {
        await ddb.send(new UpdateCommand({
          TableName: TABLE_NAME,
          Key: suggestionKey(tenantId, contentId, s.suggestionId),
          UpdateExpression: "SET #status = :skipped, #resolvedAt = :now",
          ExpressionAttributeNames: { "#status": "status", "#resolvedAt": "resolvedAt" },
          ExpressionAttributeValues: {
            ":skipped": "skipped",
            ":now": new Date().toISOString(),
            ":pending": "pending",
          },
          ConditionExpression: "attribute_exists(sk) AND #status = :pending",
        }));
        skipped += 1;
      }
    } catch (err) {
      if (isConditionalCheckFailed(err)) {
        continue; // already resolved by a concurrent action — leave it be
      }
      throw err;
    }
  }

  return { kept, skipped };
}
