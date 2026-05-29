import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/cloudfront-signer";

// Storage + signing glue for vendor report HTML artifacts. Rendered
// reports are written to a private S3 bucket and served only through a
// CloudFront distribution behind signed URLs, so the bucket is never
// publicly readable. Kept separate from services/s3.mjs (the briefs
// bucket) so the two buckets / signing schemes don't get tangled.

const s3 = new S3Client({});

// Default link lifetime: one week. Long enough that a vendor can revisit
// the same link for a few days; short enough that a leaked URL expires.
const DEFAULT_EXPIRES_SECONDS = 7 * 24 * 60 * 60;

// Exposed so the list endpoint can skip records whose S3 object would be
// lifecycle-deleted before a link minted now would expire.
export const SIGNED_URL_TTL_SECONDS = DEFAULT_EXPIRES_SECONDS;

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

// Mints a CloudFront signed URL for a previously-stored report key. Pure
// (no I/O) so the list endpoint can cheaply re-sign many keys to hand out
// fresh links without re-rendering. Returns the URL and its expiry.
export function signReportUrl(key, { expiresInSeconds = DEFAULT_EXPIRES_SECONDS } = {}) {
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
  const url = getSignedUrl({
    url: `https://${process.env.VENDOR_REPORTS_DOMAIN}/${key}`,
    keyPairId: process.env.VENDOR_REPORTS_KEY_PAIR_ID,
    privateKey: process.env.VENDOR_REPORTS_SIGNING_PRIVATE_KEY,
    dateLessThan: expiresAt,
  });
  return { url, expiresAt };
}
