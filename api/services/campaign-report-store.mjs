import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

// Storage glue for campaign report HTML artifacts. Like vendor reports,
// rendered campaign reports are written to the private reports bucket and
// served only through CloudFront behind signed URLs. They share the SAME
// bucket/distribution as vendor reports but live under a distinct
// `reports/campaigns/...` key prefix.
//
// Signing is NOT reimplemented here: services/vendor-report-store.mjs
// exports a generic `signReportUrl(key)` (the signing scheme is keyed off
// the object key, not the vendor) which the routes reuse for both kinds.

const s3 = new S3Client({});

function campaignReportKey(campaignId, reportId) {
  return `reports/campaigns/${campaignId}/${reportId}.html`;
}

// Writes the fully-rendered campaign report HTML to the reports bucket.
// Marked `private, no-store` so neither CloudFront nor intermediaries
// cache it; the signed URL is the only access path. Returns the key.
export async function putCampaignReportHtml({ campaignId, reportId, html }) {
  const key = campaignReportKey(campaignId, reportId);
  await s3.send(new PutObjectCommand({
    Bucket: process.env.VENDOR_REPORTS_BUCKET,
    Key: key,
    Body: html,
    ContentType: "text/html; charset=utf-8",
    CacheControl: "private, no-store",
  }));
  return key;
}
