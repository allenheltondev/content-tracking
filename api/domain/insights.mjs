import { listCampaigns } from "./campaign.mjs";
import { listSocialPosts, listSocialPostSnapshots } from "./social-post.mjs";
import { listContentPosts, listContentPostSnapshots } from "./content-post.mjs";
import { splitPostMetrics } from "./post-metrics.mjs";

// Account-level Trends & Insights. Turns the per-post daily snapshots we
// already capture (pk=CAMPAIGN#{id}, sk={SOCIAL,CONTENT}POST#{pid}#SNAPSHOT#{date})
// into a cross-campaign view: an engagement time series, top performers, and
// period-over-period deltas.
//
// There is no cross-campaign / by-date index on snapshots, so this fans out
// — campaigns -> posts -> snapshots — and aggregates in memory. That mirrors
// the media-kit aggregate and is fine at personal scale. If the dataset ever
// outgrows a per-request fan-out, the place to add a precomputed daily
// rollup (written on each analytics PUT, or by a scheduled job) is here,
// behind the same buildInsightsSummary contract.
//
// Snapshots are CUMULATIVE levels: each day's metric map is the running total
// for that post as of that day (the analytics PUT overwrites same-day). The
// series we return is therefore cumulative levels with carry-forward across
// gaps; the UI derives day-over-day deltas from it client-side. Carry-forward
// (not zero-fill) is what makes the series robust to irregular capture.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Adds `days` (may be negative) to a YYYY-MM-DD date, returning YYYY-MM-DD.
function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Inclusive day count between two YYYY-MM-DD dates.
function dayspan(startDate, endDate) {
  const a = new Date(`${startDate}T00:00:00Z`).getTime();
  const b = new Date(`${endDate}T00:00:00Z`).getTime();
  return Math.round((b - a) / MS_PER_DAY) + 1;
}

const zero = () => ({ views: 0, impressions: 0, engagements: 0 });

/**
 * Build the account-wide insights summary for a date range.
 *
 * @param {object} args
 * @param {string} args.startDate - inclusive ISO date (YYYY-MM-DD).
 * @param {string} args.endDate   - inclusive ISO date (YYYY-MM-DD).
 * @param {number} [args.topLimit=10] - max top-performing posts to return.
 */
export async function buildInsightsSummary({ startDate, endDate, topLimit = 10, tenantId }) {
  const campaigns = await listAllCampaigns(tenantId);
  const campaignName = new Map(campaigns.map((c) => [c.campaignId, c.name]));

  // Fan out to every tracked post, then to each post's snapshot history.
  const postBatches = await Promise.all(
    campaigns.map(async (c) => {
      const [social, content] = await Promise.all([
        listSocialPosts(c.campaignId),
        listContentPosts(c.campaignId),
      ]);
      return [
        ...social.map((p) => ({ post: p, kind: "social" })),
        ...content.map((p) => ({ post: p, kind: "content" })),
      ];
    }),
  );
  const posts = postBatches.flat();

  // For each post, load snapshots and normalize to a sorted series of
  // cumulative levels: [{ date, views, impressions, engagements }].
  const series = await Promise.all(
    posts.map(async ({ post, kind }) => {
      const rows =
        kind === "social"
          ? await listSocialPostSnapshots(post.campaignId, post.postId)
          : await listContentPostSnapshots(post.campaignId, post.postId);
      const levels = rows.map((r) => ({
        date: r.snapshotDate,
        ...splitPostMetrics(r.metrics),
      }));
      return { post, kind, levels };
    }),
  );

  // --- daily time series (cumulative levels, carry-forward) -------------
  const dayCount = dayspan(startDate, endDate);
  const days = Array.from({ length: dayCount }, (_, i) => addDays(startDate, i));
  const dailyTotals = days.map(() => zero());

  for (const { levels } of series) {
    if (levels.length === 0) continue;
    let i = 0;
    let carried = null;
    // Seed carry-in: the latest level strictly before the window start.
    while (i < levels.length && levels[i].date < startDate) {
      carried = levels[i];
      i += 1;
    }
    for (let d = 0; d < days.length; d += 1) {
      const day = days[d];
      while (i < levels.length && levels[i].date <= day) {
        carried = levels[i];
        i += 1;
      }
      if (carried) {
        dailyTotals[d].views += carried.views;
        dailyTotals[d].impressions += carried.impressions;
        dailyTotals[d].engagements += carried.engagements;
      }
    }
  }

  const timeseries = days.map((date, d) => ({
    date,
    views: dailyTotals[d].views,
    impressions: dailyTotals[d].impressions,
    engagements: dailyTotals[d].engagements,
  }));

  // --- period-over-period deltas ---------------------------------------
  // Cumulative level summed across posts, as of an arbitrary day.
  const sumLevelAt = (day) => {
    const total = zero();
    for (const { levels } of series) {
      const lvl = latestLevelOnOrBefore(levels, day);
      if (lvl) {
        total.views += lvl.views;
        total.impressions += lvl.impressions;
        total.engagements += lvl.engagements;
      }
    }
    return total;
  };

  const beforeStart = addDays(startDate, -1);
  const priorStart = addDays(startDate, -dayCount);
  const beforePriorStart = addDays(priorStart, -1);

  const atEnd = sumLevelAt(endDate);
  const atBeforeStart = sumLevelAt(beforeStart);
  const atBeforePriorStart = sumLevelAt(beforePriorStart);

  const gainedThisPeriod = diff(atEnd, atBeforeStart);
  const gainedPriorPeriod = diff(atBeforeStart, atBeforePriorStart);

  // --- top performers + per-platform (current levels in range) ---------
  const ranked = [];
  const byPlatform = new Map();
  for (const { post, kind, levels } of series) {
    const lvl = latestLevelOnOrBefore(levels, endDate);
    if (!lvl) continue;
    const lastCaptured = levels[levels.length - 1]?.date ?? null;
    ranked.push({
      platform: post.platform ?? null,
      kind,
      url: post.url ?? null,
      campaignId: post.campaignId,
      campaignName: campaignName.get(post.campaignId) ?? null,
      views: lvl.views,
      impressions: lvl.impressions,
      engagements: lvl.engagements,
      lastCaptured,
    });
    const key = post.platform ?? "unknown";
    const agg = byPlatform.get(key) ?? zero();
    agg.views += lvl.views;
    agg.impressions += lvl.impressions;
    agg.engagements += lvl.engagements;
    byPlatform.set(key, agg);
  }
  ranked.sort((a, b) => b.engagements - a.engagements);

  const totals = sumTotals(ranked);

  return {
    range: { startDate, endDate, days: dayCount },
    totals: {
      ...totals,
      reach: totals.views + totals.impressions,
      engagementRate:
        totals.views + totals.impressions > 0
          ? totals.engagements / (totals.views + totals.impressions)
          : null,
      postsTracked: ranked.length,
    },
    deltas: {
      thisPeriod: gainedThisPeriod,
      priorPeriod: gainedPriorPeriod,
      changePct: {
        views: pctChange(gainedThisPeriod.views, gainedPriorPeriod.views),
        impressions: pctChange(gainedThisPeriod.impressions, gainedPriorPeriod.impressions),
        engagements: pctChange(gainedThisPeriod.engagements, gainedPriorPeriod.engagements),
      },
    },
    timeseries,
    topPosts: ranked.slice(0, topLimit),
    byPlatform: [...byPlatform.entries()]
      .map(([platform, m]) => ({ platform, ...m }))
      .sort((a, b) => b.engagements - a.engagements),
  };
}

// Binary-friendly linear scan for the latest cumulative level on or before a
// day. Series are short (one entry per capture day) so a scan is fine.
function latestLevelOnOrBefore(levels, day) {
  let found = null;
  for (const lvl of levels) {
    if (lvl.date <= day) found = lvl;
    else break;
  }
  return found;
}

function diff(a, b) {
  return {
    views: a.views - b.views,
    impressions: a.impressions - b.impressions,
    engagements: a.engagements - b.engagements,
  };
}

function sumTotals(rows) {
  const total = zero();
  for (const r of rows) {
    total.views += r.views;
    total.impressions += r.impressions;
    total.engagements += r.engagements;
  }
  return total;
}

// Period-over-period percentage change. Null when the prior period had no
// gain to compare against (avoids a misleading "+Infinity%").
function pctChange(current, prior) {
  if (typeof prior !== "number" || prior <= 0) return null;
  return (current - prior) / prior;
}

// Drains the paginated campaign list into a flat array. Insights span every
// campaign regardless of status. Personal-scale, so fully consuming the
// pages is fine. (Mirrors the media-kit helper.)
async function listAllCampaigns(tenantId) {
  const all = [];
  let exclusiveStartKey;
  do {
    const { items, lastEvaluatedKey } = await listCampaigns({
      limit: 500,
      exclusiveStartKey,
      tenantId,
    });
    for (const item of items) all.push(item);
    exclusiveStartKey = lastEvaluatedKey;
  } while (exclusiveStartKey);
  return all;
}
