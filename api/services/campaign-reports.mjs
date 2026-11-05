import { ulid } from "ulid";
import { buildCampaignReportSnapshot } from "../domain/campaign-report.mjs";
import {
  claimCampaignReportSupersede,
  getCampaignReportRecord,
  listCampaignReportRecords,
  releaseCampaignReportSupersede,
  saveCampaignReportRecord,
} from "../domain/campaign-report-record.mjs";
import {
  ensureCampaignReportLinkToken,
  getCampaignReportLinkToken,
} from "../domain/campaign-report-link.mjs";
// Retention helpers shared with vendor reports: REPORT_RETENTION_DAYS is the
// bucket/record lifetime (90d default); reportObjectExpiresAtMs(record) is the
// epoch-ms the S3 object behind a record is deleted.
import { REPORT_RETENTION_DAYS, reportObjectExpiresAtMs } from "../domain/vendor-report-record.mjs";
import {
  extractCampaignReportSnapshot,
  renderCampaignReportHtml,
} from "./campaign-report-renderer.mjs";
import {
  getCampaignReportHtml,
  putCampaignReportHtml,
  replaceCampaignReportHtml,
} from "./campaign-report-store.mjs";
import { runInBatches } from "./concurrency.mjs";
import { logger } from "./logger.mjs";
import { mintShortLink } from "./newsletter-service.mjs";
// Signing is generic (keyed off the object key, not the vendor) so we
// reuse it straight from the vendor report store for campaign reports too.
import { signReportUrl } from "./report-signing.mjs";

// Campaign report generation and listing, shared by the REST routes
// (routes/campaign-reports.mjs) and the MCP tools. Callers check campaign
// ownership first. `latestUrlFor(token)` turns the campaign's stable link
// token into the public /public/campaign-reports/{token} URL for the API
// host the request came in on (publicReportLinkUrl), so this module stays
// free of HTTP events.

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

// Generates a fresh campaign report: builds the snapshot, renders the
// HTML, stores it in the private reports bucket, persists a record, and
// returns a signed CloudFront link valid for the report's full lifetime.
// Campaign analytics is all-time, so there is no period.
export async function generateCampaignReport({ campaignId, latestUrlFor }) {
  const [snapshot, linkToken] = await Promise.all([
    buildCampaignReportSnapshot({ campaignId }),
    ensureCampaignReportLinkToken(campaignId),
  ]);
  const latestUrl = latestUrlFor(linkToken);

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

  return {
    reportId,
    url,
    shortUrl,
    latestUrl,
    expiresAt,
    dataAsOf: snapshot.report.dataAsOf,
    summary: snapshot.summary,
  };
}

// Lists previously-generated reports newest-first, minting a fresh signed
// link for each that lasts exactly as long as the report's S3 object. Any
// record whose object has already aged out is skipped: re-signing one
// would just hand back a URL that 404s at the CloudFront edge.
export async function listCampaignReports({ campaignId, latestUrlFor }) {
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

  return { latestUrl: latestUrlFor(linkToken), reports };
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

// The report (object + record) ages out RETENTION_MS after it was generated.
// Falls back to now+retention if generatedAt is unparseable, mirroring the
// TTL fallback in campaign-report-record.mjs.
function reportExpiresAt(generatedAt) {
  const generatedMs = Date.parse(generatedAt ?? "");
  const baseMs = Number.isNaN(generatedMs) ? Date.now() : generatedMs;
  return new Date(baseMs + RETENTION_MS).toISOString();
}
