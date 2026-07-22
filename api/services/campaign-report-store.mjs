import { PutObjectCommand } from "@aws-sdk/client-s3";
import { s3 } from "./s3.mjs";

// Storage glue for campaign report HTML artifacts. Like vendor reports,
// rendered campaign reports are written to the private reports bucket and
// served only through CloudFront behind signed URLs. They share the SAME
// bucket/distribution as vendor reports but live under a distinct
// `reports/campaigns/...` key prefix.
//
// Signing is NOT reimplemented here: services/report-signing.mjs exports
// the generic `signReportUrl(key)` (keyed off the object key, not the
// resource) which the routes reuse for every report family.

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
