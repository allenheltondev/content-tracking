import { PutObjectCommand } from "@aws-sdk/client-s3";
import { s3 } from "./s3.mjs";

// Storage glue for vendor report HTML artifacts. Rendered reports are
// written to a private S3 bucket and served only through a CloudFront
// distribution behind signed URLs, so the bucket is never publicly
// readable. Signing lives in services/report-signing.mjs (shared with
// campaign reports, media kits, and profile assets).

function reportKey(vendorId, reportId) {
  return `reports/${vendorId}/${reportId}.html`;
}

// Writes the fully-rendered report HTML to the reports bucket. Marked
// `private, no-store` so neither CloudFront nor intermediaries cache it;
// the signed URL is the only access path.
export async function putReportHtml({ vendorId, reportId, html }) {
  const key = reportKey(vendorId, reportId);
  await s3.send(new PutObjectCommand({
    Bucket: process.env.VENDOR_REPORTS_BUCKET,
    Key: key,
    Body: html,
    ContentType: "text/html; charset=utf-8",
    CacheControl: "private, no-store",
  }));
  return key;
}
