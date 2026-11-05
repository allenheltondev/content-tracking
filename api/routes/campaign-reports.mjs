import { BadRequestError } from "../services/errors.mjs";
import { jsonResponse } from "../services/http-handler.mjs";
import { assertCampaignOwned } from "../domain/campaign.mjs";
import { requireTenantId } from "../services/identity.mjs";
import { generateCampaignReport, listCampaignReports } from "../services/campaign-reports.mjs";
import { signReportUrl } from "../services/report-signing.mjs";
import { findNewestCampaignReportRecord } from "../domain/campaign-report-record.mjs";
import {
  publicReportLinkUrl,
  resolveCampaignReportLinkToken,
} from "../domain/campaign-report-link.mjs";
import { reportObjectExpiresAtMs } from "../domain/vendor-report-record.mjs";

// Generation, listing, and the supersede banner rewrite live in
// services/campaign-reports.mjs so the MCP tools share them.

// Campaign ids are ULIDs. validation/campaign.mjs has no exported id regex,
// so we validate path params locally with the same 1-80 char shape used for
// vendor ids (letters, digits, underscores, hyphens), which a ULID satisfies.
const CAMPAIGN_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

export function registerCampaignReportRoutes(app) {
  // POST /campaigns/:campaignId/report
  //
  // Generates a fresh campaign report and returns a signed link valid for
  // the report's full lifetime. The request body is ignored.
  app.post("/campaigns/:campaignId/report", async ({ event, params }) => {
    const campaignId = requireValidCampaignId(params.campaignId);
    const tenantId = requireTenantId(event);
    await assertCampaignOwned(campaignId, tenantId);
    const report = await generateCampaignReport({
      campaignId,
      latestUrlFor: (token) => publicReportLinkUrl(event, token),
    });
    return jsonResponse(201, report);
  });

  // GET /campaigns/:campaignId/reports
  //
  // Lists previously-generated, still-retained reports newest-first with a
  // freshly signed link for each.
  app.get("/campaigns/:campaignId/reports", async ({ event, params }) => {
    const campaignId = requireValidCampaignId(params.campaignId);
    const tenantId = requireTenantId(event);
    await assertCampaignOwned(campaignId, tenantId);
    const { latestUrl, reports } = await listCampaignReports({
      campaignId,
      latestUrlFor: (token) => publicReportLinkUrl(event, token),
    });
    return jsonResponse(200, { campaign_id: campaignId, latest_url: latestUrl, reports });
  });

  // GET /public/campaign-reports/:token
  //
  // The campaign's stable sponsor link. Unauthenticated (the API Gateway
  // event for this path sets Authorizer: NONE); the 128-bit token is the
  // only credential, exactly like the signed URL it hands out. Redirects to
  // a freshly signed URL for the newest report that is still retained, or
  // answers with a small "no longer available" page.
  app.get("/public/campaign-reports/:token", async ({ params }) => {
    const campaignId = await resolveCampaignReportLinkToken(params.token);
    if (!campaignId) return unavailablePage(404);

    // Newest-first and paged, so the redirect always lands on the actual
    // latest report even when the campaign's records span several pages.
    const nowMs = Date.now();
    const remainingSeconds = (r) => Math.floor((reportObjectExpiresAtMs(r) - nowMs) / 1000);
    const record = await findNewestCampaignReportRecord(campaignId, (r) => remainingSeconds(r) > 60);
    if (!record) return unavailablePage(410);

    const { url } = signReportUrl(record.key, { expiresInSeconds: remainingSeconds(record) });
    return {
      statusCode: 302,
      headers: {
        location: url,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
      body: "",
    };
  });
}

function unavailablePage(statusCode) {
  return {
    statusCode,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
    },
    body: [
      "<!DOCTYPE html>",
      '<html lang="en"><head><meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<meta name="robots" content="noindex, nofollow">',
      "<title>Report unavailable</title></head>",
      '<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;',
      'background:#f3f4f6;color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif">',
      '<main style="max-width:420px;padding:32px;text-align:center">',
      '<h1 style="font-size:20px;margin:0 0 8px">This report is no longer available</h1>',
      '<p style="margin:0;color:#64748b;font-size:14px">Ask the sender for an updated report.</p>',
      "</main></body></html>",
    ].join(""),
  };
}

function requireValidCampaignId(campaignId) {
  if (!CAMPAIGN_ID_RE.test(campaignId ?? "")) {
    throw new BadRequestError(
      "campaignId must be 1-80 characters of letters, digits, underscores, or hyphens",
    );
  }
  return campaignId;
}
