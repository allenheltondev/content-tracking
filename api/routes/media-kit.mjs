import { ulid } from "ulid";
import { jsonResponse } from "../services/http-handler.mjs";
import { logger } from "../services/logger.mjs";
import { buildMediaKitSnapshot } from "../domain/media-kit.mjs";
import { requireTenantId } from "../services/identity.mjs";
import { renderMediaKitHtml } from "../services/media-kit-renderer.mjs";
import { putMediaKitHtml } from "../services/media-kit-store.mjs";
// Signing is generic (keyed off the object key) so we reuse it straight from
// the vendor report store for media kits too.
import { signReportUrl } from "../services/report-signing.mjs";
import { mintShortLink } from "../services/newsletter-service.mjs";
import { saveMediaKitRecord, listMediaKitRecords } from "../domain/media-kit-record.mjs";
// Retention helpers shared with the reports: REPORT_RETENTION_DAYS is the
// bucket/record lifetime (90d default); reportObjectExpiresAtMs(record) is
// the epoch-ms the S3 object behind a record is deleted.
import {
  REPORT_RETENTION_DAYS,
  reportObjectExpiresAtMs,
} from "../domain/vendor-report-record.mjs";

// Media-kit share links live as long as the kit itself (the S3 object + the
// DynamoDB record both age out at REPORT_RETENTION_DAYS). Signing for the
// full window — including the embedded avatar/logo image URLs — means a link
// handed to a brand keeps working for the kit's entire life.
const MEDIA_KIT_TTL_SECONDS = REPORT_RETENTION_DAYS * 24 * 60 * 60;
const RETENTION_MS = MEDIA_KIT_TTL_SECONDS * 1000;

async function mintMediaKitShortLink(url) {
  try {
    const mint = await mintShortLink({
      url,
      src: "media-kit",
      expiresInDays: REPORT_RETENTION_DAYS,
    });
    return mint?.short_url ?? null;
  } catch (err) {
    logger.warn("Failed to mint shortlink for media kit; falling back to signed URL", {
      error: err?.message,
    });
    return null;
  }
}

export function registerMediaKitRoutes(app) {
  // POST /media-kit
  //
  // Generates a fresh media kit: builds the snapshot from the creator profile
  // + aggregate performance, renders the HTML (with avatar/logo image URLs
  // signed for the kit's full lifetime), stores it in the private reports
  // bucket, persists a record, and returns a signed CloudFront share link.
  app.post("/media-kit", async ({ event }) => {
    const tenantId = requireTenantId(event);
    const reportId = ulid();
    const snapshot = await buildMediaKitSnapshot({
      assetUrlTtlSeconds: MEDIA_KIT_TTL_SECONDS,
      tenantId,
    });
    snapshot.report.id = reportId;

    const html = renderMediaKitHtml(snapshot);
    const key = await putMediaKitHtml({ reportId, html });
    // The object was just written, so its lifetime starts now: sign for the
    // full retention window and report the matching expiration.
    const { url } = signReportUrl(key, { expiresInSeconds: MEDIA_KIT_TTL_SECONDS });
    const expiresAt = mediaKitExpiresAt(snapshot.report.generatedAt);
    const shortUrl = await mintMediaKitShortLink(url);

    await saveMediaKitRecord({
      reportId,
      key,
      generatedAt: snapshot.report.generatedAt,
      dataAsOf: snapshot.report.dataAsOf,
      stats: snapshot.stats,
    });

    return jsonResponse(201, {
      reportId,
      url,
      shortUrl,
      expiresAt,
      dataAsOf: snapshot.report.dataAsOf,
      stats: snapshot.stats,
    });
  });

  // GET /media-kit
  //
  // Lists previously-generated media kits newest-first, minting a FRESH
  // signed link for each that lasts exactly as long as the kit's S3 object.
  // Any record whose object has already aged out is skipped — re-signing one
  // would just hand back a URL that 404s at the CloudFront edge.
  app.get("/media-kit", async () => {
    const records = await listMediaKitRecords();

    const nowMs = Date.now();
    const mediaKits = records
      .map((record) => {
        const objectExpiryMs = reportObjectExpiresAtMs(record);
        const remainingSeconds = Math.floor((objectExpiryMs - nowMs) / 1000);
        if (remainingSeconds <= 0) return null;
        const { url } = signReportUrl(record.key, { expiresInSeconds: remainingSeconds });
        return {
          reportId: record.reportId,
          generatedAt: record.generatedAt,
          dataAsOf: record.dataAsOf,
          stats: record.stats ?? null,
          url,
          expiresAt: new Date(objectExpiryMs).toISOString(),
        };
      })
      .filter(Boolean);

    return jsonResponse(200, { media_kits: mediaKits });
  });
}

// The kit (object + record) ages out RETENTION_MS after it was generated.
// Falls back to now+retention if generatedAt is unparseable, mirroring the
// TTL fallback in media-kit-record.mjs.
function mediaKitExpiresAt(generatedAt) {
  const generatedMs = Date.parse(generatedAt ?? "");
  const baseMs = Number.isNaN(generatedMs) ? Date.now() : generatedMs;
  return new Date(baseMs + RETENTION_MS).toISOString();
}
