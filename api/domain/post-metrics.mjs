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

export function splitPostMetrics(analytics) {
  let views = 0;
  let impressions = 0;
  let engagements = 0;
  if (analytics && typeof analytics === "object") {
    for (const [k, v] of Object.entries(analytics)) {
      const n = typeof v === "number" && Number.isFinite(v) ? v : 0;
      if (VIEW_KEY.test(k)) views += n;
      else if (IMPRESSION_KEY.test(k)) impressions += n;
      else engagements += n;
    }
  }
  return { views, impressions, engagements };
}
