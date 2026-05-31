import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

// Storage glue for media-kit HTML artifacts. Like the campaign and vendor
// reports, rendered media kits are written to the private reports bucket and
// served only through CloudFront behind signed URLs. They share the SAME
// bucket/distribution but live under a distinct `reports/media-kit/...` key
// prefix.
//
// Signing is NOT reimplemented here: services/vendor-report-store.mjs
// exports a generic `signReportUrl(key)` (the signing scheme is keyed off
// the object key, not the resource) which the route reuses.

const s3 = new S3Client({});

function mediaKitKey(reportId) {
  return `reports/media-kit/${reportId}.html`;
}

// Writes the fully-rendered media-kit HTML to the reports bucket. Marked
// `private, no-store` so neither CloudFront nor intermediaries cache it; the
// signed URL is the only access path. Returns the key.
export async function putMediaKitHtml({ reportId, html }) {
  const key = mediaKitKey(reportId);
  await s3.send(new PutObjectCommand({
    Bucket: process.env.VENDOR_REPORTS_BUCKET,
    Key: key,
    Body: html,
    ContentType: "text/html; charset=utf-8",
    CacheControl: "private, no-store",
  }));
  return key;
}
