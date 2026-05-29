import { ulid } from "ulid";
import { BadRequestError } from "../services/errors.mjs";
import { jsonResponse } from "../services/http-handler.mjs";
import { logger } from "../services/logger.mjs";
import { buildCampaignReportSnapshot } from "../domain/campaign-report.mjs";
import { renderCampaignReportHtml } from "../services/campaign-report-renderer.mjs";
import { putCampaignReportHtml } from "../services/campaign-report-store.mjs";
// Signing is generic (keyed off the object key, not the vendor) so we
// reuse it straight from the vendor report store for campaign reports too.
import { signReportUrl } from "../services/vendor-report-store.mjs";
import { mintShortLink } from "../services/newsletter-service.mjs";
import {
  saveCampaignReportRecord,
  listCampaignReportRecords,
} from "../domain/campaign-report-record.mjs";
// Retention helpers shared with vendor reports: REPORT_RETENTION_DAYS is the
// bucket/record lifetime (90d default); reportObjectExpiresAtMs(record) is the
// epoch-ms the S3 object behind a record is deleted.
import {
  REPORT_RETENTION_DAYS,
  reportObjectExpiresAtMs,
} from "../domain/vendor-report-record.mjs";

// Campaign report links live as long as the report itself (the S3 object +
// DynamoDB record both age out at REPORT_RETENTION_DAYS). Signing for the
// full window means the share link a customer is handed keeps working for
// the entire life of the report, not just a few days. This is deliberately
// longer-lived than vendor report links — vendor reports keep the store's
// 7-day default.
const CAMPAIGN_REPORT_TTL_SECONDS = REPORT_RETENTION_DAYS * 24 * 60 * 60;
const RETENTION_MS = CAMPAIGN_REPORT_TTL_SECONDS * 1000;

async function mintReportShortLink(url) {
  try {
    const mint = await mintShortLink({
      url,
      src: "campaign-report",
      expiresInDays: REPORT_RETENTION_DAYS,
    });
    return mint?.short_url ?? null;
  } catch (err) {
    logger.warn("Failed to mint shortlink for campaign report; falling back to signed URL", {
      error: err?.message,
    });
    return null;
  }
}

// Campaign ids are ULIDs. validation/campaign.mjs has no exported id regex,
// so we validate path params locally with the same 1-80 char shape used for
// vendor ids (letters, digits, underscores, hyphens), which a ULID satisfies.
const CAMPAIGN_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

export function registerCampaignReportRoutes(app) {
  // POST /campaigns/:campaignId/report
  //
  // Generates a fresh campaign report: builds the snapshot, renders the
  // HTML, stores it in the private reports bucket, persists a record, and
  // returns a signed CloudFront link valid for the report's full lifetime.
  // Campaign analytics is all-time, so there is NO period — the request body
  // is ignored.
  app.post("/campaigns/:campaignId/report", async ({ params }) => {
    const campaignId = requireValidCampaignId(params.campaignId);

    const snapshot = await buildCampaignReportSnapshot({ campaignId });

    const reportId = ulid();
    snapshot.report.id = reportId;

    const html = renderCampaignReportHtml(snapshot);
    const key = await putCampaignReportHtml({ campaignId, reportId, html });
    // The object was just written, so its lifetime starts now: sign for the
    // full retention window and report the matching expiration.
    const { url } = signReportUrl(key, { expiresInSeconds: CAMPAIGN_REPORT_TTL_SECONDS });
    const expiresAt = reportExpiresAt(snapshot.report.generatedAt);
    const shortUrl = await mintReportShortLink(url);

    await saveCampaignReportRecord({
      campaignId,
      reportId,
      key,
      generatedAt: snapshot.report.generatedAt,
      dataAsOf: snapshot.report.dataAsOf,
      summary: snapshot.summary,
    });

    return jsonResponse(201, {
      reportId,
      url,
      shortUrl,
      expiresAt,
      dataAsOf: snapshot.report.dataAsOf,
      summary: snapshot.summary,
    });
  });

  // GET /campaigns/:campaignId/reports
  //
  // Lists previously-generated reports newest-first, minting a FRESH signed
  // link for each that lasts exactly as long as the report's S3 object. Any
  // record whose object has already aged out is skipped — re-signing one
  // would just hand back a URL that 404s at the CloudFront edge.
  app.get("/campaigns/:campaignId/reports", async ({ params }) => {
    const campaignId = requireValidCampaignId(params.campaignId);
    const records = await listCampaignReportRecords(campaignId);

    const nowMs = Date.now();
    const reports = records
      .map((record) => {
        const objectExpiryMs = reportObjectExpiresAtMs(record);
        const remainingSeconds = Math.floor((objectExpiryMs - nowMs) / 1000);
        if (remainingSeconds <= 0) return null;
        const { url } = signReportUrl(record.key, { expiresInSeconds: remainingSeconds });
        return {
          reportId: record.reportId,
          generatedAt: record.generatedAt,
          dataAsOf: record.dataAsOf,
          url,
          expiresAt: new Date(objectExpiryMs).toISOString(),
        };
      })
      .filter(Boolean);

    return jsonResponse(200, { campaign_id: campaignId, reports });
  });
}

// The report (object + record) ages out RETENTION_MS after it was generated.
// Falls back to now+retention if generatedAt is unparseable, mirroring the
// TTL fallback in campaign-report-record.mjs.
function reportExpiresAt(generatedAt) {
  const generatedMs = Date.parse(generatedAt ?? "");
  const baseMs = Number.isNaN(generatedMs) ? Date.now() : generatedMs;
  return new Date(baseMs + RETENTION_MS).toISOString();
}

function requireValidCampaignId(campaignId) {
  if (!CAMPAIGN_ID_RE.test(campaignId ?? "")) {
    throw new BadRequestError(
      "campaignId must be 1-80 characters of letters, digits, underscores, or hyphens",
    );
  }
  return campaignId;
}
