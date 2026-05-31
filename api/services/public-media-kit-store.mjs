import {
  CopyObjectCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

// Storage glue for the PUBLIC media kit (the brand-facing teaser published
// to a stable vanity URL). Unlike the signed campaign/vendor reports, these
// objects live in a dedicated bucket served by a CloudFront distribution
// with NO signature requirement — anyone with the link can view them. The
// bucket itself stays private (OAC); CloudFront is the only reader.
//
// Keeping public content in its own bucket means a config slip here can
// never expose the private, signed-URL-only sponsor reports.

const s3 = new S3Client({});

const PUBLIC_BUCKET = process.env.PUBLIC_MEDIA_KIT_BUCKET;
const PUBLIC_DOMAIN = process.env.PUBLIC_MEDIA_KIT_DOMAIN;

// Published kits update in place on republish, so allow a short edge cache
// rather than no-store — the page is meant to be hit repeatedly by brands
// and crawlers.
const CACHE_CONTROL = "public, max-age=300";

// The stable public URL for a slug. The page object is stored under the bare
// slug key so the vanity URL has no extension (https://<domain>/<slug>).
export function publicMediaKitUrl(slug) {
  return `https://${PUBLIC_DOMAIN}/${slug}`;
}

// Writes the rendered teaser HTML to the public bucket at the slug key.
export async function publishMediaKitHtml({ slug, html }) {
  await s3.send(new PutObjectCommand({
    Bucket: PUBLIC_BUCKET,
    Key: slug,
    Body: html,
    ContentType: "text/html; charset=utf-8",
    CacheControl: CACHE_CONTROL,
  }));
  return publicMediaKitUrl(slug);
}

// Removes a published kit (the page plus any copied avatar/logo images).
// Best-effort: a missing object is not an error, so unpublish stays
// idempotent even if some assets were never copied.
export async function unpublishMediaKit({ slug }) {
  const keys = [slug, `${slug}/avatar`, `${slug}/logo`];
  await Promise.all(
    keys.map((Key) =>
      s3
        .send(new DeleteObjectCommand({ Bucket: PUBLIC_BUCKET, Key }))
        .catch(() => undefined),
    ),
  );
}

// avatar/logo originals live in the private reports bucket under
// `profile/{kind}-{ulid}.{ext}`. A permanent public page can't reference a
// short-lived signed URL, so at publish time we copy the image into the
// public bucket under `{slug}/{kind}` and return its public URL. The
// extension is dropped from the public key (content-type is preserved by
// CopyObject) so the URL stays clean and stable across re-uploads.
const ASSET_KIND_RE = /^profile\/(avatar|logo)-/;

export async function copyProfileAssetToPublic({ key, slug }) {
  const match = ASSET_KIND_RE.exec(key ?? "");
  if (!match) return null;
  const kind = match[1];
  const destKey = `${slug}/${kind}`;
  await s3.send(new CopyObjectCommand({
    Bucket: PUBLIC_BUCKET,
    // CopySource must be URL-encoded and bucket-qualified.
    CopySource: encodeURI(`${process.env.VENDOR_REPORTS_BUCKET}/${key}`),
    Key: destKey,
    MetadataDirective: "COPY",
    CacheControl: CACHE_CONTROL,
  }));
  return `https://${PUBLIC_DOMAIN}/${destKey}`;
}
