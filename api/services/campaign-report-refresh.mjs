import { findCampaign, getCampaignWithLinks } from "../domain/campaign.mjs";
import {
  claimCampaignReportRefresh,
  getCampaignReportLinkToken,
} from "../domain/campaign-report-link.mjs";
import { findNewestCampaignReportRecord } from "../domain/campaign-report-record.mjs";
import {
  clearRefreshRequest,
  getRefreshRequest,
  recordRefreshRequest,
} from "../domain/campaign-refresh-request.mjs";
import { findNewestServableCampaignReport, generateCampaignReport } from "./campaign-reports.mjs";
import { logger } from "./logger.mjs";

// Keeping sponsor reports fresh. Two entry points:
//
// - refreshFromPublicLink: the "Refresh stats" form on a report posts to the
//   stable sponsor link. It regenerates the report so the live sources
//   (clicks, GA4, YouTube) update, and asks the Chrome extension to re-scrape
//   the extension-sourced posts of a campaign that is still monitoring.
// - completeMonitoringSweep: the extension reports it finished scraping a
//   campaign. A pending sponsor request, or posts synced after the newest
//   report, regenerate the report so the stable link shows the new numbers.
//
// `latestUrlFor(token)` maps the campaign's link token to its public URL, as
// in services/campaign-reports.mjs.

// The public refresh is unauthenticated (the link token is the only
// credential), so generations from it are spaced at least this far apart.
// Submits inside the window skip straight to the newest snapshot.
export const PUBLIC_REFRESH_COOLDOWN_MINUTES = 10;
const PUBLIC_REFRESH_COOLDOWN_MS = PUBLIC_REFRESH_COOLDOWN_MINUTES * 60 * 1000;

// Result of a public refresh:
//   { status: "unavailable" }   no servable report (the route answers like
//                               the GET does)
//   { status: "ok", url, notice }
// `notice` names what the report page tells the sponsor: "requested" when
// the extension has a pending request for the campaign, "done" when the
// stats are as fresh as they get, null when regeneration failed and the
// sponsor lands on the previous snapshot.
export async function refreshFromPublicLink({ campaignId, latestUrlFor }) {
  const [campaign, newest] = await Promise.all([
    findCampaign(campaignId),
    findNewestServableCampaignReport(campaignId),
  ]);
  // Without a live snapshot the stable link is already "no longer
  // available". A public submit does not bring an aged-out report back.
  if (!newest) return { status: "unavailable" };
  // A deleted campaign keeps serving what it has, like the GET.
  if (!campaign) return { status: "ok", url: newest.url, notice: null };

  const refreshRequested = await requestExtensionRefresh(campaign);
  const notice = refreshRequested ? "requested" : "done";

  if (!(await shouldRegenerate(campaignId, newest.record))) {
    return { status: "ok", url: newest.url, notice };
  }
  try {
    const report = await generateCampaignReport({ campaignId, latestUrlFor });
    return { status: "ok", url: report.url, notice };
  } catch (err) {
    // The sponsor still lands on the newest stored snapshot, with no notice
    // claiming the stats were refreshed. The claim stays, so a failing
    // upstream is retried after the cooldown and not on every submit.
    logger.warn("Public campaign report refresh failed", { campaignId, error: err?.message });
    return { status: "ok", url: newest.url, notice: null };
  }
}

// Only a monitoring campaign has posts the extension still scrapes. Legacy
// campaigns without a tenantId have no tenant partition to record into.
async function requestExtensionRefresh(campaign) {
  if (campaign.status !== "monitoring") return false;
  if (!campaign.tenantId) {
    logger.warn("Skipping refresh request for a campaign without a tenant", {
      campaignId: campaign.campaignId,
    });
    return false;
  }
  await recordRefreshRequest(campaign.tenantId, campaign.campaignId);
  return true;
}

async function shouldRegenerate(campaignId, newestRecord) {
  const generatedMs = Date.parse(newestRecord?.generatedAt ?? "");
  if (!Number.isNaN(generatedMs) && Date.now() - generatedMs < PUBLIC_REFRESH_COOLDOWN_MS) {
    return false;
  }
  // The conditional claim makes concurrent submits converge on one
  // generation per cooldown window.
  return claimCampaignReportRefresh(campaignId, { cooldownMs: PUBLIC_REFRESH_COOLDOWN_MS });
}

// Called after the caller verified the campaign belongs to `tenantId`.
// Regenerates only for a campaign that already has a sponsor link (never
// mints one), and only when a request was pending or a post synced after
// the newest report. A pending request is cleared once handled, so a failed
// generation leaves it for the extension's next sweep.
//
// `partial` means some posts failed to sync. The request is then not
// handled yet: it stays pending for the extension's retry, and only posts
// that did sync can regenerate the report.
export async function completeMonitoringSweep({
  tenantId,
  campaignId,
  latestUrlFor,
  partial = false,
}) {
  const [pending, token] = await Promise.all([
    getRefreshRequest(tenantId, campaignId),
    getCampaignReportLinkToken(campaignId),
  ]);
  const handled = Boolean(pending) && !partial;

  let regenerated = false;
  if (token && (handled || (await hasPostsSyncedSinceNewestReport(campaignId)))) {
    await generateCampaignReport({ campaignId, latestUrlFor });
    regenerated = true;
  }

  if (handled) await clearRefreshRequest(tenantId, campaignId, pending.requestedAt);
  return { regenerated };
}

async function hasPostsSyncedSinceNewestReport(campaignId) {
  const [newest, { socialPosts, contentPosts }] = await Promise.all([
    findNewestCampaignReportRecord(campaignId, () => true),
    getCampaignWithLinks(campaignId),
  ]);
  const parsedReportMs = Date.parse(newest?.generatedAt ?? "");
  const reportMs = Number.isNaN(parsedReportMs) ? -Infinity : parsedReportMs;
  return [...(socialPosts ?? []), ...(contentPosts ?? [])].some((post) => {
    const fetchedMs = Date.parse(post.lastFetched ?? "");
    return !Number.isNaN(fetchedMs) && fetchedMs > reportMs;
  });
}
