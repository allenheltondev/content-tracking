// Shared classification of an open-ended engagement metric map (the shape
// the Chrome extension writes onto social/content posts) into three
// buckets: views, impressions, and engagements. Reach metrics (views,
// impressions) are kept OUT of the engagement total so the two figures
// never double-count the same interaction.
//
// Keys are matched by name rather than a fixed schema because each
// platform reports a different metric set. Used by both the campaign
// report snapshot and the media-kit aggregate so the two always agree on
// what counts as engagement.

const VIEW_KEY = /^(views?|pageviews?|screenpageviews)$/i;
const IMPRESSION_KEY = /^impressions?$/i;

// Classifies the metric map into the three buckets and also reports which
// buckets the platform actually populated. The `present` flags track whether
// a bucket carried any numeric key at all — distinct from a summed zero. A
// platform that never emits an impressions key (Bluesky, dev.to, a blog) has
// `present.impressions === false`, which the per-channel report renders as
// "—" rather than a misleading 0.
export function classifyPostMetrics(analytics) {
  const sums = { views: 0, impressions: 0, engagements: 0 };
  const present = { views: false, impressions: false, engagements: false };
  if (analytics && typeof analytics === "object") {
    for (const [k, v] of Object.entries(analytics)) {
      const isNum = typeof v === "number" && Number.isFinite(v);
      const n = isNum ? v : 0;
      const bucket = VIEW_KEY.test(k) ? "views" : IMPRESSION_KEY.test(k) ? "impressions" : "engagements";
      sums[bucket] += n;
      if (isNum) present[bucket] = true;
    }
  }
  return { ...sums, present };
}

export function splitPostMetrics(analytics) {
  const { views, impressions, engagements } = classifyPostMetrics(analytics);
  return { views, impressions, engagements };
}
