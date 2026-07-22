import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { TABLE_NAME, ddb, isConditionalCheckFailed } from "../services/ddb.mjs";
import { NotFoundError } from "../services/errors.mjs";
import { tenantPartition } from "./blog.mjs";

// The "voice" memory: per-tenant, per-platform writing-style learning. All
// rows live under pk = TENANT#{tenantId} (the Cognito sub from the authorizer,
// never the client), giving the same structural isolation as blog.mjs.
//
//   Voice sample      pk=TENANT#{tenantId}  sk=VOICE#SAMPLE#{platform}#{ulid}
//   Voice profile     pk=TENANT#{tenantId}  sk=VOICE#PROFILE#{platform}
//   Voice reflection  pk=TENANT#{tenantId}  sk=VOICE#REFLECTION#{platform}#{ulid}
//
// The sample sk embeds the platform so "recent N for a platform" is a
// begins_with Query — no GSI needed. Sample ids are ULIDs for API-created
// samples but deterministic (CONTENT-{id}) for auto-captured ones, so the sk
// is NOT reliably time-ordered; listRecentSamples sorts by the recency anchor
// (publishedAt ?? createdAt) in code instead. Reflection ids are ULIDs
// (time-ordered); the profile is a singleton per platform.
//
// Only VoiceSample is watched by the stream consumer (VoiceMemoryFunction);
// VoiceProfile / VoiceReflection carry different entity values so the
// function's own writes never re-trigger it (mirrors the Content / content
// vector-state split in content.mjs).

export function voiceSampleKey(tenantId, platform, sampleId) {
  return { pk: tenantPartition(tenantId), sk: `VOICE#SAMPLE#${platform}#${sampleId}` };
}

export function voiceProfileKey(tenantId, platform) {
  return { pk: tenantPartition(tenantId), sk: `VOICE#PROFILE#${platform}` };
}

export function voiceReflectionKey(tenantId, platform, reflectionId) {
  return { pk: tenantPartition(tenantId), sk: `VOICE#REFLECTION#${platform}#${reflectionId}` };
}

const SAMPLE_PREFIX = (platform) => `VOICE#SAMPLE#${platform}#`;
const REFLECTION_PREFIX = (platform) => `VOICE#REFLECTION#${platform}#`;

// Creates a voice sample. The stream consumer does the rest (embed → vector →
// counter → maybe reflect). `sampleId` is normally a fresh ULID; the
// auto-capture and seed paths pass a deterministic id (derived from the source
// content) so re-runs overwrite instead of duplicating. `publishedAt` anchors
// the sample on the recency-decay curve (see services/voice-recency.mjs);
// when absent, createdAt is the fallback anchor.
export async function createVoiceSample(tenantId, { text, platform, format, source = "manual", sampleId, publishedAt } = {}) {
  const id = sampleId ?? ulid();
  const now = new Date().toISOString();
  const item = {
    ...voiceSampleKey(tenantId, platform, id),
    entity: "VoiceSample",
    tenantId,
    sampleId: id,
    platform,
    format,
    source,
    text,
    createdAt: now,
  };
  if (publishedAt) {
    item.publishedAt = publishedAt;
  }
  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
  return item;
}

// Most-recent samples for a platform, newest first by the recency anchor
// (publishedAt, falling back to createdAt). Used both by the GET route
// (bounded list) and the reflection candidate pool.
//
// Reads the platform's whole sample prefix and sorts in code: deterministic
// auto-capture ids (CONTENT-...) don't interleave with ULIDs in sk order, and
// publish dates don't follow capture order anyway, so a Limit on the Query
// would silently drop genuinely recent samples. A tenant's per-platform corpus
// is personal-scale (mirrors listContentStats), so consuming all pages is fine.
export async function listRecentSamples(tenantId, platform, limit = 50) {
  const items = [];
  let exclusiveStartKey;
  do {
    const result = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":pk": tenantPartition(tenantId),
        ":prefix": SAMPLE_PREFIX(platform),
      },
      ExclusiveStartKey: exclusiveStartKey,
    }));
    for (const it of result.Items ?? []) items.push(it);
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  items.sort((a, b) => sampleRecencyTimestamp(b) - sampleRecencyTimestamp(a));
  return items.slice(0, limit);
}

// Millisecond timestamp of a sample's recency anchor; unparseable/missing
// dates sort oldest.
function sampleRecencyTimestamp(item) {
  const t = Date.parse(item.publishedAt ?? item.createdAt ?? "");
  return Number.isNaN(t) ? 0 : t;
}

export async function getVoiceSample(tenantId, platform, sampleId) {
  const result = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: voiceSampleKey(tenantId, platform, sampleId),
  }));
  return result.Item ?? null;
}

// Deletes a sample row (the route also removes its vector). Throws NotFound
// when the sample doesn't exist so DELETE is a clean 404 rather than a no-op.
export async function deleteVoiceSampleRow(tenantId, platform, sampleId) {
  try {
    await ddb.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: voiceSampleKey(tenantId, platform, sampleId),
      ConditionExpression: "attribute_exists(sk)",
    }));
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      throw new NotFoundError("VoiceSample", sampleId);
    }
    throw err;
  }
}

// Mutes or unmutes a sample. A muted sample stays in the corpus (so the user
// can see and reverse it) but is excluded from reflection and has its vector
// removed by the route, so it no longer drives the learned voice. Auto-capture
// preserves the muted flag across content edits, so muting a published post is
// a durable "keep this out of my voice". Returns the updated row.
export async function setVoiceSampleMuted(tenantId, platform, sampleId, muted) {
  const expr = muted
    ? { UpdateExpression: "SET muted = :m", values: { ":m": true } }
    : { UpdateExpression: "REMOVE muted", values: {} };
  try {
    const result = await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: voiceSampleKey(tenantId, platform, sampleId),
      UpdateExpression: expr.UpdateExpression,
      ConditionExpression: "attribute_exists(sk)",
      ...(Object.keys(expr.values).length > 0 ? { ExpressionAttributeValues: expr.values } : {}),
      ReturnValues: "ALL_NEW",
    }));
    return result.Attributes;
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      throw new NotFoundError("VoiceSample", sampleId);
    }
    throw err;
  }
}

// Sets (or clears, with null) the per-platform steering note — a short "what
// I'm going for lately" that biases the next reflection. Upserts the profile
// row so a note can be set before any samples exist, mirroring countSampleOnce's
// creation of the row. Returns the updated profile row.
export async function setVoiceSteering(tenantId, platform, note) {
  const now = new Date().toISOString();
  const base = "SET entity = if_not_exists(entity, :e), tenantId = if_not_exists(tenantId, :t), "
    + "platform = if_not_exists(platform, :p), createdAt = if_not_exists(createdAt, :now), updatedAt = :now";
  const result = await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: voiceProfileKey(tenantId, platform),
    UpdateExpression: note === null ? `${base} REMOVE steering` : `${base}, steering = :s`,
    ExpressionAttributeValues: {
      ":e": "VoiceProfile",
      ":t": tenantId,
      ":p": platform,
      ":now": now,
      ...(note === null ? {} : { ":s": note }),
    },
    ReturnValues: "ALL_NEW",
  }));
  return result.Attributes;
}

// Counts a new sample toward the platform's reflection cadence — exactly once,
// even under the stream's at-least-once delivery. A single transaction marks
// the sample (conditional on not-yet-marked) AND increments the profile counter
// (creating the profile row on first use). Because the two writes are atomic,
// a sample can never end up marked-but-uncounted: a redelivered record fails
// the condition and the whole unit is skipped. Returns { counted, count }; the
// count is read consistently so the caller's reflection decision sees the
// just-written total.
export async function countSampleOnce(tenantId, platform, sampleId) {
  const now = new Date().toISOString();
  try {
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: TABLE_NAME,
            Key: voiceSampleKey(tenantId, platform, sampleId),
            UpdateExpression: "SET vectorizedAt = :now",
            ConditionExpression: "attribute_not_exists(vectorizedAt)",
            ExpressionAttributeValues: { ":now": now },
          },
        },
        {
          Update: {
            TableName: TABLE_NAME,
            Key: voiceProfileKey(tenantId, platform),
            UpdateExpression:
              "SET entity = if_not_exists(entity, :e), tenantId = if_not_exists(tenantId, :t), "
              + "platform = if_not_exists(platform, :p), createdAt = if_not_exists(createdAt, :now), "
              + "updatedAt = :now ADD samplesSinceReflection :one",
            ExpressionAttributeValues: {
              ":e": "VoiceProfile",
              ":t": tenantId,
              ":p": platform,
              ":now": now,
              ":one": 1,
            },
          },
        },
      ],
    }));
  } catch (err) {
    // The sample's conditional check failing means it was already counted on an
    // earlier delivery — skip. Any other cancellation (throttle, conflict) is
    // transient: rethrow so the stream retries the whole unit.
    if (err instanceof TransactionCanceledException
      && err.CancellationReasons?.[0]?.Code === "ConditionalCheckFailed") {
      return { counted: false, count: 0 };
    }
    throw err;
  }

  const res = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: voiceProfileKey(tenantId, platform),
    ConsistentRead: true,
    ProjectionExpression: "samplesSinceReflection",
  }));
  return { counted: true, count: res.Item?.samplesSinceReflection ?? 0 };
}

export async function getVoiceProfile(tenantId, platform) {
  const result = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: voiceProfileKey(tenantId, platform),
  }));
  return result.Item ?? null;
}

// Lists every platform profile for the tenant (the profiles overview).
export async function listProfiles(tenantId) {
  const result = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: {
      ":pk": tenantPartition(tenantId),
      ":prefix": "VOICE#PROFILE#",
    },
  }));
  return result.Items ?? [];
}

// Writes the (re)reflected profile: the full JSON profile, a bumped version,
// and the counter reset to 0. createdAt is preserved from the prior row when
// present so the profile keeps its original birth time. steering (the user's
// intent note) is preserved too — this Put overwrites the whole row, so the
// caller passes the current note back in or it would be lost.
export async function putVoiceProfile(tenantId, platform, { profile, version, createdAt, steering }) {
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  const item = {
    ...voiceProfileKey(tenantId, platform),
    entity: "VoiceProfile",
    tenantId,
    platform,
    profile,
    samplesSinceReflection: 0,
    version,
    createdAt: createdAt ?? nowIso,
    updatedAt: nowIso,
    // Stamp the reflection time (epoch ms) for the cooldown gate, and — because
    // this Put replaces the whole row — implicitly release any reflection claim.
    lastReflectionAtMs: nowMs,
  };
  if (steering) {
    item.steering = steering;
  }
  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
  return item;
}

// Atomically claims the right to run a reflection for this platform, gating the
// automatic (stream-driven) path so bursty ingress can't stampede Bedrock. The
// claim succeeds only when the profile is dirty (>= threshold new samples), the
// cooldown since the last reflection has elapsed, and no other claim is live
// (a claim older than the lease is considered abandoned — e.g. a crashed
// reflection — and can be re-taken). Returns true iff this caller won the slot
// and should run the reflection; concurrent/rapid callers get false and skip.
export async function claimReflectionSlot(tenantId, platform, { now, cooldownMs, leaseMs, threshold }) {
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: voiceProfileKey(tenantId, platform),
      UpdateExpression: "SET reflectionClaimedAt = :now",
      ConditionExpression:
        "attribute_exists(sk) AND samplesSinceReflection >= :threshold "
        + "AND (attribute_not_exists(lastReflectionAtMs) OR lastReflectionAtMs <= :cooldownCutoff) "
        + "AND (attribute_not_exists(reflectionClaimedAt) OR reflectionClaimedAt <= :leaseCutoff)",
      ExpressionAttributeValues: {
        ":now": now,
        ":threshold": threshold,
        ":cooldownCutoff": now - cooldownMs,
        ":leaseCutoff": now - leaseMs,
      },
    }));
    return true;
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      return false;
    }
    throw err;
  }
}

// Records a reflection in the audit trail (one row per profile update).
// halfLifeDays captures the recency-decay setting the reflection ran with, so
// profile changes stay explainable after the knob is retuned. version and
// portrait snapshot the resulting profile so the reflection list doubles as a
// "your voice over time" history without a separate snapshot store.
export async function createReflection(tenantId, platform, { changeSummary, sampleWindow, model, halfLifeDays, version, portrait }) {
  const id = ulid();
  const now = new Date().toISOString();
  const item = {
    ...voiceReflectionKey(tenantId, platform, id),
    entity: "VoiceReflection",
    tenantId,
    platform,
    reflectionId: id,
    changeSummary,
    sampleWindow,
    model,
    createdAt: now,
  };
  if (halfLifeDays !== undefined && halfLifeDays !== null) {
    item.halfLifeDays = halfLifeDays;
  }
  if (version !== undefined && version !== null) {
    item.version = version;
  }
  if (portrait) {
    item.portrait = portrait;
  }
  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
  return item;
}

export async function listReflections(tenantId, platform, limit = 10) {
  const result = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: {
      ":pk": tenantPartition(tenantId),
      ":prefix": REFLECTION_PREFIX(platform),
    },
    ScanIndexForward: false,
    Limit: limit,
  }));
  return result.Items ?? [];
}
