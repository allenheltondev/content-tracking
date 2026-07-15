import { BadRequestError } from "../services/errors.mjs";
import { jsonResponse, emptyResponse } from "../services/http-handler.mjs";
import { logger } from "../services/logger.mjs";
import { getProfileSettings } from "../domain/profile.mjs";
import {
  markPublicMediaKitPublished,
  clearPublicMediaKitPublished,
} from "../domain/profile.mjs";
import { buildMediaKitSnapshot, toPublicTeaser } from "../domain/media-kit.mjs";
import { requireTenantId } from "../services/identity.mjs";
import { trackActivity } from "../services/activity.mjs";
import { renderMediaKitHtml } from "../services/media-kit-renderer.mjs";
import {
  publishMediaKitHtml,
  unpublishMediaKit,
  copyProfileAssetToPublic,
  publicMediaKitUrl,
  writePublicMediaKitSeoFiles,
  removePublicMediaKitSeoFiles,
} from "../services/public-media-kit-store.mjs";

// The public, brand-facing media kit: a teaser published to a stable vanity
// URL (https://<public-host>/<slug>) that anyone can view — the inbound
// front door. Distinct from POST /media-kit, which mints a private,
// signed, expiring link for targeted brand sends. Generation here is still
// fully Cognito-gated; only the resulting static page is public.

export function registerMediaKitPublishRoutes(app) {
  // POST /media-kit/publish
  //
  // Renders the public teaser (no rate card) from the current profile +
  // aggregate stats, copies the avatar/logo into the public bucket so the
  // permanent page has permanent image URLs, writes the page to the slug,
  // and stamps the profile as published. Requires a public_slug to be set
  // first via PUT /profile.
  app.post("/media-kit/publish", async ({ event }) => {
    const tenantId = requireTenantId(event);
    const profile = await getProfileSettings();
    const slug = profile?.publicSlug;
    if (!slug) {
      throw new BadRequestError(
        "Set a public_slug via PUT /profile before publishing a public media kit.",
      );
    }

    const snapshot = await buildMediaKitSnapshot({ tenantId });

    // Copy avatar/logo originals (private reports bucket) into the public
    // bucket so the permanent page references permanent URLs, not the
    // short-lived signed URLs buildMediaKitSnapshot produced.
    const [avatarUrl, logoUrl] = await Promise.all([
      profile.avatarKey
        ? copyProfileAssetToPublic({ key: profile.avatarKey, slug }).catch((err) => {
            logger.warn("Failed to copy avatar to public bucket", { error: err?.message });
            return null;
          })
        : Promise.resolve(null),
      profile.logoKey
        ? copyProfileAssetToPublic({ key: profile.logoKey, slug }).catch((err) => {
            logger.warn("Failed to copy logo to public bucket", { error: err?.message });
            return null;
          })
        : Promise.resolve(null),
    ]);

    const url = publicMediaKitUrl(slug);
    const teaser = toPublicTeaser(snapshot, { avatarUrl, logoUrl });
    // pageUrl drives the canonical link + OG/Twitter/JSON-LD url fields.
    const html = renderMediaKitHtml(teaser, { indexable: true, pageUrl: url });
    await publishMediaKitHtml({ slug, html });

    // robots.txt + sitemap.xml at the bucket root point crawlers at the
    // single published page. Best-effort: SEO-file failures must not fail
    // the publish itself.
    const publishedAt = new Date().toISOString();
    await writePublicMediaKitSeoFiles({ slug, lastmod: publishedAt }).catch((err) => {
      logger.warn("Failed to write media-kit SEO files", { error: err?.message });
    });

    await markPublicMediaKitPublished(publishedAt);

    // Gamification: publishing the public media kit is the "Press Ready"
    // activity. Keyed on this publish's timestamp so a retry of the same
    // publish is deduped, while a genuine re-publish later still counts.
    await trackActivity(tenantId, "mediakit.published", {
      id: `mediakit.published#${tenantId}#${publishedAt}`,
    });

    return jsonResponse(200, { slug, url, published: true, published_at: publishedAt });
  });

  // DELETE /media-kit/publish
  //
  // Takes the public page down: removes the page + copied images and clears
  // the published timestamp. Idempotent — unpublishing when nothing is
  // published is a no-op success.
  app.delete("/media-kit/publish", async () => {
    const profile = await getProfileSettings();
    const slug = profile?.publicSlug;
    if (slug) {
      await unpublishMediaKit({ slug });
      // Drop robots.txt + sitemap.xml so crawlers stop being pointed at the
      // now-gone page. Best-effort.
      await removePublicMediaKitSeoFiles().catch((err) => {
        logger.warn("Failed to remove media-kit SEO files", { error: err?.message });
      });
    }
    await clearPublicMediaKitPublished();
    return emptyResponse(204);
  });

  // GET /media-kit/publish
  //
  // Reports the current public-kit state (slug, published flag, URL).
  app.get("/media-kit/publish", async () => {
    const profile = await getProfileSettings();
    const slug = profile?.publicSlug ?? null;
    const published = Boolean(profile?.publicMediaKitPublishedAt);
    return jsonResponse(200, {
      slug,
      published,
      url: slug && published ? publicMediaKitUrl(slug) : null,
      published_at: profile?.publicMediaKitPublishedAt ?? null,
    });
  });
}
