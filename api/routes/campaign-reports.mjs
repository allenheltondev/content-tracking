import { ulid } from "ulid";
import { BadRequestError } from "../services/errors.mjs";
import { jsonResponse } from "../services/http-handler.mjs";
import { buildCampaignReportSnapshot } from "../domain/campaign-report.mjs";
import { renderCampaignReportHtml } from "../services/campaign-report-renderer.mjs";
import { putCampaignReportHtml } from "../services/campaign-report-store.mjs";
// Signing is generic (keyed off the object key, not the vendor) so we
// reuse it straight from the vendor report store for campaign reports too.
import { signReportUrl, SIGNED_URL_TTL_SECONDS } from "../services/vendor-report-store.mjs";
import {
  saveCampaignReportRecord,
  listCampaignReportRecords,
} from "../domain/campaign-report-record.mjs";
// Generic retention helper shared with vendor reports.
import { reportObjectExpiresAtMs } from "../domain/vendor-report-record.mjs";

// Campaign ids are ULIDs. validation/campaign.mjs has no exported id regex,
// so we validate path params locally with the same 1-80 char shape used for
// vendor ids (letters, digits, underscores, hyphens), which a ULID satisfies.
const CAMPAIGN_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

export function registerCampaignReportRoutes(app) {
  // POST /campaigns/:campaignId/report
  //
  // Generates a fresh campaign report: builds the snapshot, renders the
  // HTML, stores it in the private reports bucket, persists a record, and
  // returns a signed CloudFront link. Campaign analytics is all-time, so
  // there is NO period — the request body is ignored.
  app.post("/campaigns/:campaignId/report", async ({ params }) => {
    const campaignId = requireValidCampaignId(params.campaignId);

    const snapshot = await buildCampaignReportSnapshot({ campaignId });

    const reportId = ulid();
    snapshot.report.id = reportId;

    const html = renderCampaignReportHtml(snapshot);
    const key = await putCampaignReportHtml({ campaignId, reportId, html });
    const { url, expiresAt } = signReportUrl(key);

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
      expiresAt,
      dataAsOf: snapshot.report.dataAsOf,
      summary: snapshot.summary,
    });
  });

  // GET /campaigns/:campaignId/reports
  //
  // Lists previously-generated reports newest-first, minting a FRESH signed
  // link for each. Skips any record whose S3 object would be
  // lifecycle-deleted before a link minted now would expire — re-signing one
  // would just hand back a URL that 403s/404s at the CloudFront edge.
  app.get("/campaigns/:campaignId/reports", async ({ params }) => {
    const campaignId = requireValidCampaignId(params.campaignId);
    const records = await listCampaignReportRecords(campaignId);

    const linkExpiryMs = Date.now() + SIGNED_URL_TTL_SECONDS * 1000;
    const reports = records
      .filter((record) => reportObjectExpiresAtMs(record) > linkExpiryMs)
      .map((record) => {
        const { url, expiresAt } = signReportUrl(record.key);
        return {
          reportId: record.reportId,
          generatedAt: record.generatedAt,
          dataAsOf: record.dataAsOf,
          url,
          expiresAt,
        };
      });

    return jsonResponse(200, { campaign_id: campaignId, reports });
  });
}

function requireValidCampaignId(campaignId) {
  if (!CAMPAIGN_ID_RE.test(campaignId ?? "")) {
    throw new BadRequestError(
      "campaignId must be 1-80 characters of letters, digits, underscores, or hyphens",
    );
  }
  return campaignId;
}
