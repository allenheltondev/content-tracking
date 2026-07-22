import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ulid } from "ulid";
import { s3 } from "./s3.mjs";
// Profile images live in the reports bucket (private, fronted by the
// reports CloudFront distribution) rather than the briefs bucket, so the
// media kit can embed them via long-lived CloudFront signed URLs that
// outlast the 7-day cap on presigned S3 GETs.
export { signReportUrl as signProfileAssetUrl } from "./report-signing.mjs";

// Profile images share the vendor-reports bucket + CloudFront distribution
// (the function's IAM policy already grants this bucket, and signReportUrl
// signs against its domain), so no new infra is needed.
const REPORTS_BUCKET = process.env.VENDOR_REPORTS_BUCKET;

const UPLOAD_EXPIRES_SECONDS = 15 * 60;

// content-type -> file extension for the image kinds we accept. The
// presigned PUT is bound to the content-type so the dashboard can't upload
// something other than the image it asked to upload.
export const IMAGE_CONTENT_TYPES = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

// Presigned URL the dashboard uses to PUT a profile image (avatar or logo)
// directly to S3. The key embeds a ULID so re-uploads never collide and an
// in-flight render keeps pointing at the prior object until the profile row
// is updated to the new key.
export async function presignProfileImageUpload({ kind, contentType }) {
  const ext = IMAGE_CONTENT_TYPES[contentType];
  const key = `profile/${kind}-${ulid()}.${ext}`;
  const command = new PutObjectCommand({
    Bucket: REPORTS_BUCKET,
    Key: key,
    ContentType: contentType,
  });
  const url = await getSignedUrl(s3, command, { expiresIn: UPLOAD_EXPIRES_SECONDS });
  return {
    key,
    url,
    expiresAt: new Date(Date.now() + UPLOAD_EXPIRES_SECONDS * 1000).toISOString(),
  };
}
