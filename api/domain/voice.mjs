import { ConditionalCheckFailedException, TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { TABLE_NAME, ddb } from "../services/ddb.mjs";
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
// begins_with Query, ULID-ordered (newest first with ScanIndexForward:false) —
// no GSI needed. Sample / reflection ids are ULIDs (time-ordered); the profile
// is a singleton per platform.
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
// counter → maybe reflect). `sampleId` is normally a fresh ULID; the seed
// script passes a deterministic id (derived from the source blog) so re-runs
// overwrite instead of duplicating.
export async function createVoiceSample(tenantId, { text, platform, format, source = "manual", sampleId } = {}) {
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
  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
  return item;
}

// Most-recent samples for a platform, newest first. Used both by the GET route
// (bounded list) and the reflection window.
export async function listRecentSamples(tenantId, platform, limit = 50) {
  const result = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: {
      ":pk": tenantPartition(tenantId),
      ":prefix": SAMPLE_PREFIX(platform),
    },
    ScanIndexForward: false,
    Limit: limit,
  }));
  return result.Items ?? [];
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
    if (err instanceof ConditionalCheckFailedException) {
      throw new NotFoundError("VoiceSample", sampleId);
    }
    throw err;
  }
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
// present so the profile keeps its original birth time.
export async function putVoiceProfile(tenantId, platform, { profile, version, createdAt }) {
  const now = new Date().toISOString();
  const item = {
    ...voiceProfileKey(tenantId, platform),
    entity: "VoiceProfile",
    tenantId,
    platform,
    profile,
    samplesSinceReflection: 0,
    version,
    createdAt: createdAt ?? now,
    updatedAt: now,
  };
  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
  return item;
}

// Records a reflection in the audit trail (one row per profile update).
export async function createReflection(tenantId, platform, { changeSummary, sampleWindow, model }) {
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
