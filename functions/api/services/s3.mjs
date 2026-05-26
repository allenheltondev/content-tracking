import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// S3 helper for the briefs bucket. Centralizes the client + bucket-name
// reference so route code doesn't sprinkle process.env access around.

const s3 = new S3Client({});
export const BRIEFS_BUCKET = process.env.BRIEFS_BUCKET;

const PRESIGN_EXPIRES_SECONDS = 15 * 60;

// Presigned URL the client uses to PUT a PDF directly to S3. Bound to
// content-type so the dashboard can't accidentally upload non-PDFs
// against an URL minted for a PDF brief.
export async function presignBriefUpload({ briefId, contentType }) {
  const key = `uploads/${briefId}.pdf`;
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
export async function putBriefTranscript({ briefId, body }) {
  const key = `uploads/${briefId}.txt`;
  await s3.send(new PutObjectCommand({
    Bucket: BRIEFS_BUCKET,
    Key: key,
    Body: body,
    ContentType: "text/plain; charset=utf-8",
  }));
  return key;
}

// Reads an object back as a Buffer. Used by the brief pipeline to load
// the uploaded PDF before passing it to Bedrock.
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
