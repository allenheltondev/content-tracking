import { ulid } from "ulid";
import { BadRequestError } from "../services/errors.mjs";
import { jsonResponse } from "../services/http-handler.mjs";
import { logger } from "../services/logger.mjs";
import { buildCampaignReportSnapshot } from "../domain/campaign-report.mjs";
import { assertCampaignOwned } from "../domain/campaign.mjs";
import { requireTenantId } from "../services/identity.mjs";
import {
  renderCampaignReportHtml,
  extractCampaignReportSnapshot,
} from "../services/campaign-report-renderer.mjs";
import {
  putCampaignReportHtml,
  getCampaignReportHtml,
  replaceCampaignReportHtml,
} from "../services/campaign-report-store.mjs";
// Signing is generic (keyed off the object key, not the vendor) so we
// reuse it straight from the vendor report store for campaign reports too.
import { signReportUrl } from "../services/report-signing.mjs";
import { mintShortLink } from "../services/newsletter-service.mjs";
import {
  saveCampaignReportRecord,
  listCampaignReportRecords,
  findNewestCampaignReportRecord,
  claimCampaignReportSupersede,
  releaseCampaignReportSupersede,
  getCampaignReportRecord,
} from "../domain/campaign-report-record.mjs";
import { runInBatches } from "../services/concurrency.mjs";
import {
  ensureCampaignReportLinkToken,
  getCampaignReportLinkToken,
  resolveCampaignReportLinkToken,
  publicReportLinkUrl,
} from "../domain/campaign-report-link.mjs";
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
  app.post("/campaigns/:campaignId/report", async ({ event, params }) => {
    const campaignId = requireValidCampaignId(params.campaignId);
    const tenantId = requireTenantId(event);
    await assertCampaignOwned(campaignId, tenantId);

    const [snapshot, linkToken] = await Promise.all([
      buildCampaignReportSnapshot({ campaignId }),
      ensureCampaignReportLinkToken(campaignId),
    ]);
    const latestUrl = publicReportLinkUrl(event, linkToken);

    const reportId = ulid();
    snapshot.report.id = reportId;
    snapshot.report.latestUrl = latestUrl;

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

    // Older snapshots get a banner pointing at the stable link. Best effort:
    // the new report is already stored and recorded, so a failure here only
    // leaves an old report without its banner until the next generation.
    await supersedePreviousReports({
      campaignId,
      currentReportId: reportId,
      supersededAt: snapshot.report.generatedAt,
      latestUrl,
    });

    return jsonResponse(201, {
      reportId,
      url,
      shortUrl,
      latestUrl,
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
  app.get("/campaigns/:campaignId/reports", async ({ event, params }) => {
    const campaignId = requireValidCampaignId(params.campaignId);
    const tenantId = requireTenantId(event);
    await assertCampaignOwned(campaignId, tenantId);
    const [records, linkToken] = await Promise.all([
      listCampaignReportRecords(campaignId),
      getCampaignReportLinkToken(campaignId),
    ]);

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
          superseded: Boolean(record.supersededAt),
        };
      })
      .filter(Boolean);

    return jsonResponse(200, {
      campaign_id: campaignId,
      latest_url: publicReportLinkUrl(event, linkToken),
      reports,
    });
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

// Most superseded rewrites one POST will do. Every retained older report is
// a candidate on each generation (so its banner advances to the newest
// report), which retention keeps small in practice; the cap keeps the
// synchronous POST well inside its timeout for a campaign regenerated very
// often. Candidates are newest-first, so the most recent snapshots, the ones
// a sponsor is likeliest to still hold, are the ones kept current.
const MAX_SUPERSEDE_PER_REQUEST = 25;

// Bound on convergence passes in supersedeOne. Each pass that loses to a
// newer claimant rewrites with that claimant's data, so two passes cover the
// realistic case of two overlapping generations.
const MAX_SUPERSEDE_PASSES = 3;

// Re-render older, still-retained reports with a supersededBy marker so they
// show the "newer version available" banner. Only reports whose ULID sorts
// before the current one qualify, so an overlapping generation can never
// banner a report newer than itself, and only ones not already claimed by a
// newer generation.
// Each rewrite is independent; failures are logged and left for the next
// generation to retry.
async function supersedePreviousReports({ campaignId, currentReportId, supersededAt, latestUrl }) {
  let records;
  try {
    records = await listCampaignReportRecords(campaignId);
  } catch (err) {
    logger.warn("Could not list campaign reports to supersede", { campaignId, error: err?.message });
    return;
  }
  const nowMs = Date.now();
  const stale = records
    .filter((r) =>
      typeof r.reportId === "string" &&
      r.reportId < currentReportId &&
      // Unclaimed, or claimed by an older generation. Filtering on the
      // claimant (not on whether a claim exists) lets each newer generation
      // advance the monotonic claim, so the banner tracks the newest report.
      (!r.supersededByReportId || r.supersededByReportId < currentReportId) &&
      reportObjectExpiresAtMs(r) > nowMs)
    .slice(0, MAX_SUPERSEDE_PER_REQUEST);

  await runInBatches(stale.map((record) => () =>
    supersedeOne({ campaignId, record, currentReportId, supersededAt, latestUrl })));
}

// Supersedes one report, safely against overlapping generations.
//
// 1. Claim the record conditionally (monotonic on the claimant's ULID). A
//    generation that loses to a newer claimant stops here.
// 2. Rewrite the HTML with the claimant's metadata.
// 3. Re-read the claim. If a newer generation claimed the report while this
//    one was writing, its S3 write may have landed first and been
//    overwritten by ours, so rewrite again with the newer claimant's data.
//    Every writer converges on the newest claim's content, whatever the
//    order the S3 writes land in.
async function supersedeOne({ campaignId, record, currentReportId, supersededAt, latestUrl }) {
  let claimed = false;
  try {
    claimed = await claimCampaignReportSupersede(campaignId, record.reportId, {
      byReportId: currentReportId,
      supersededAt,
    });
    if (!claimed) return;

    let winner = { reportId: currentReportId, supersededAt };
    for (let pass = 0; pass < MAX_SUPERSEDE_PASSES; pass++) {
      const snapshot = extractCampaignReportSnapshot(await getCampaignReportHtml(record.key));
      if (!snapshot) throw new Error("embedded snapshot missing or unreadable");
      snapshot.report = {
        ...(snapshot.report ?? {}),
        latestUrl: latestUrl ?? snapshot.report?.latestUrl ?? null,
        supersededBy: { url: latestUrl, generatedAt: winner.supersededAt },
      };
      await replaceCampaignReportHtml(record.key, renderCampaignReportHtml(snapshot));

      const current = await getCampaignReportRecord(campaignId, record.reportId);
      const holder = current?.supersededByReportId;
      if (!holder || holder === winner.reportId) return;
      winner = { reportId: holder, supersededAt: current.supersededAt };
    }
    logger.warn("Campaign report supersede did not settle", { campaignId, reportId: record.reportId });
  } catch (err) {
    logger.warn("Could not mark campaign report superseded", {
      campaignId,
      reportId: record.reportId,
      error: err?.message,
    });
    if (claimed) {
      await releaseCampaignReportSupersede(campaignId, record.reportId, currentReportId).catch(() => {});
    }
  }
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
