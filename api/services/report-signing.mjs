import { getSignedUrl } from "@aws-sdk/cloudfront-signer";

// CloudFront URL signing for the private reports bucket. One generic
// signer keyed off the object key serves every artifact family that
// lives behind the reports distribution — vendor reports, campaign
// reports, media kits, and profile assets. Moved out of
// vendor-report-store.mjs, where three unrelated stores had to import
// it from.

// Default link lifetime: one week. Long enough that a vendor can revisit
// the same link for a few days; short enough that a leaked URL expires.
const DEFAULT_EXPIRES_SECONDS = 7 * 24 * 60 * 60;

// Exposed so list endpoints can skip records whose S3 object would be
// lifecycle-deleted before a link minted now would expire.
export const SIGNED_URL_TTL_SECONDS = DEFAULT_EXPIRES_SECONDS;

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
