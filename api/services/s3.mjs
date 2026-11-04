import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// The one shared S3 client for the service (module singleton, reused
// across warm invocations), plus helpers for the briefs bucket. The
// report/media-kit/profile stores import `s3` from here instead of each
// constructing their own client.

export const s3 = new S3Client({});
export const BRIEFS_BUCKET = process.env.BRIEFS_BUCKET;

const PRESIGN_EXPIRES_SECONDS = 15 * 60;

// Bound to content-type so the dashboard can't upload some other kind of file
// against a URL minted for a brief.
async function presignBriefPut(key, contentType) {
  const command = new PutObjectCommand({
    Bucket: BRIEFS_BUCKET,
    Key: key,
    ContentType: contentType,
  });
  const url = await getSignedUrl(s3, command, {
    expiresIn: PRESIGN_EXPIRES_SECONDS,
  });
  return {
    key,
    url,
    expiresAt: new Date(Date.now() + PRESIGN_EXPIRES_SECONDS * 1000).toISOString(),
  };
}

// Where a campaign's brief file lives. Keyed by campaignId since a campaign
// owns at most one brief.
export function briefFileKey(campaignId, format) {
  return `uploads/${campaignId}.${format}`;
}

// Where a brief waits before its campaign exists. Tenant-scoped so one tenant
// can't claim another's upload by guessing its id. A lifecycle rule expires
// anything left behind.
export function stagedBriefKey(tenantId, uploadId, format) {
  return `staged/${tenantId}/${uploadId}.${format}`;
}

// Presigned URL the client uses to PUT a brief file directly to S3.
export async function presignBriefUpload({ campaignId, format, contentType }) {
  return presignBriefPut(briefFileKey(campaignId, format), contentType);
}

export async function presignStagedBriefUpload({ tenantId, uploadId, format, contentType }) {
  return presignBriefPut(stagedBriefKey(tenantId, uploadId, format), contentType);
}

// Moves a staged brief to its permanent key once the campaign exists.
export async function moveBriefObject({ from, to }) {
  await s3.send(new CopyObjectCommand({
    Bucket: BRIEFS_BUCKET,
    CopySource: encodeURI(`${BRIEFS_BUCKET}/${from}`),
    Key: to,
  }));
  await s3.send(new DeleteObjectCommand({ Bucket: BRIEFS_BUCKET, Key: from }));
}

// Presigned URL the audit view returns to clients so they can download
// the raw upload without the Lambda streaming it through.
export async function presignBriefDownload(key) {
  const command = new GetObjectCommand({
    Bucket: BRIEFS_BUCKET,
    Key: key,
  });
  return getSignedUrl(s3, command, {
    expiresIn: PRESIGN_EXPIRES_SECONDS,
  });
}

// Writes a chat transcript (already serialized to UTF-8 text) to S3 so
// every brief — PDF or chat — has a single canonical raw artifact in
// the same bucket.
export async function putBriefTranscript({ campaignId, body }) {
  const key = `uploads/${campaignId}.txt`;
  await s3.send(new PutObjectCommand({
    Bucket: BRIEFS_BUCKET,
    Key: key,
    Body: body,
    ContentType: "text/plain; charset=utf-8",
  }));
  return key;
}

// Reads an object back as a Buffer. Used by the brief pipeline to load
// the uploaded file before passing it to Bedrock.
export async function getBriefObjectBytes(key) {
  const response = await s3.send(new GetObjectCommand({
    Bucket: BRIEFS_BUCKET,
    Key: key,
  }));
  const chunks = [];
  for await (const chunk of response.Body) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
