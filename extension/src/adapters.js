// Per-platform adapters. Each one knows how to:
//   parsePostId(url)  -> the platform-native id embedded in a tracked
//                        post's URL (tweet id, LinkedIn activity id,
//                        Instagram shortcode), or null.
//   extract(body)     -> a list of { nativeId, metrics } pulled out of a
//                        captured API response. nativeId may be null when
//                        the payload doesn't carry one, in which case the
//                        background script falls back to the current page's
//                        post id.
//
// These read the platforms' own internal API responses, which are
// undocumented and change over time. The walkers are deliberately
// defensive (depth-capped, type-guarded) and report whatever metrics they
// can find; a platform tweak should degrade to "no metrics" rather than
// throw. Update the shape-matching here if a platform stops syncing.

const MAX_DEPTH = 14;

// Depth-first walk that calls `visit` on every plain object encountered.
function walk(node, visit, depth = 0) {
  if (!node || typeof node !== "object" || depth > MAX_DEPTH) return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit, depth + 1);
    return;
  }
  visit(node);
  for (const key in node) {
    const value = node[key];
    if (value && typeof value === "object") walk(value, visit, depth + 1);
  }
}

// Adds `name`->number to `metrics` only when `value` is a usable count.
function num(metrics, name, value) {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n === "number" && Number.isFinite(n) && n >= 0) {
    metrics[name] = n;
  }
}

function pick(...values) {
  for (const v of values) {
    const n = typeof v === "string" ? Number(v) : v;
    if (typeof n === "number" && Number.isFinite(n) && n >= 0) return n;
  }
  return undefined;
}

const twitter = {
  platform: "twitter",
  parsePostId(url) {
    const m = /\/status(?:es)?\/(\d+)/.exec(url || "");
    return m ? m[1] : null;
  },
  extract(body) {
    const out = [];
    const seen = new Set();
    walk(body, (node) => {
      const legacy = node.legacy;
      if (!legacy || typeof legacy.favorite_count !== "number") return;
      const nativeId = node.rest_id || legacy.id_str || legacy.conversation_id_str;
      if (!nativeId || seen.has(String(nativeId))) return;

      const metrics = {};
      num(metrics, "likes", legacy.favorite_count);
      num(metrics, "reposts", legacy.retweet_count);
      num(metrics, "replies", legacy.reply_count);
      num(metrics, "quotes", legacy.quote_count);
      num(metrics, "bookmarks", legacy.bookmark_count);
      const views = pick(node.views?.count, node.ext_views?.count);
      if (views !== undefined) metrics.views = views;

      if (Object.keys(metrics).length) {
        seen.add(String(nativeId));
        out.push({ nativeId: String(nativeId), metrics });
      }
    });
    return out;
  },
};

const ACTIVITY_RE = /urn:li:(?:activity|ugcPost|share):(\d+)/;

function findLinkedInActivityId(node) {
  for (const key of ["urn", "entityUrn", "dashEntityUrn", "updateUrn", "*urn", "preDashEntityUrn"]) {
    const value = node[key];
    if (typeof value === "string") {
      const m = ACTIVITY_RE.exec(value);
      if (m) return m[1];
    }
  }
  // Last resort: scan all shallow string fields for an activity urn.
  for (const key in node) {
    const value = node[key];
    if (typeof value === "string" && value.includes("urn:li:")) {
      const m = ACTIVITY_RE.exec(value);
      if (m) return m[1];
    }
  }
  return null;
}

const linkedin = {
  platform: "linkedin",
  parsePostId(url) {
    const u = url || "";
    const m =
      ACTIVITY_RE.exec(u) ||
      /[:-]activity[:-](\d+)/.exec(u) ||
      /-(\d{17,20})(?:[/?#-]|$)/.exec(u);
    return m ? m[1] : null;
  },
  extract(body) {
    const out = [];
    const seen = new Set();
    walk(body, (node) => {
      // Only the wrapper node owns the counts; matching on the wrapper key
      // (rather than raw numLikes) avoids re-emitting the inner counts
      // object the walker also visits.
      const counts = node.totalSocialActivityCounts || node.socialActivityCounts;
      const hasCounts =
        counts &&
        (typeof counts.numLikes === "number" ||
          typeof counts.numComments === "number" ||
          typeof counts.numShares === "number");
      if (!hasCounts) return;

      const metrics = {};
      num(metrics, "likes", counts.numLikes);
      num(metrics, "comments", counts.numComments);
      num(metrics, "reposts", counts.numShares);
      num(metrics, "impressions", counts.numImpressions ?? counts.numViews);
      if (!Object.keys(metrics).length) return;

      const id = findLinkedInActivityId(node) || findLinkedInActivityId(counts);
      const key = id ? String(id) : null;
      if (key && seen.has(key)) return;
      if (key) seen.add(key);
      out.push({ nativeId: key, metrics });
    });
    return out;
  },
};

const instagram = {
  platform: "instagram",
  parsePostId(url) {
    const m = /\/(?:p|reel|reels|tv)\/([^/?#]+)/.exec(url || "");
    return m ? m[1] : null;
  },
  extract(body) {
    const out = [];
    const seen = new Set();
    const push = (code, metrics) => {
      if (!code || seen.has(code) || !Object.keys(metrics).length) return;
      seen.add(code);
      out.push({ nativeId: String(code), metrics });
    };
    walk(body, (node) => {
      // REST media shape: { code, like_count, comment_count, play_count, ... }
      if (typeof node.code === "string" && (typeof node.like_count === "number" || typeof node.comment_count === "number")) {
        const metrics = {};
        num(metrics, "likes", node.like_count);
        num(metrics, "comments", node.comment_count);
        const views = pick(node.play_count, node.ig_play_count, node.view_count, node.video_view_count);
        if (views !== undefined) metrics.views = views;
        push(node.code, metrics);
      }
      // GraphQL shortcode_media shape.
      if (
        typeof node.shortcode === "string" &&
        (node.edge_media_preview_like || node.edge_liked_by || node.edge_media_to_comment || node.edge_media_to_parent_comment)
      ) {
        const metrics = {};
        num(metrics, "likes", node.edge_media_preview_like?.count ?? node.edge_liked_by?.count);
        num(metrics, "comments", node.edge_media_to_parent_comment?.count ?? node.edge_media_to_comment?.count);
        num(metrics, "views", node.video_view_count);
        push(node.shortcode, metrics);
      }
    });
    return out;
  },
};

export const adapters = { twitter, linkedin, instagram };

// URL substrings worth capturing, per platform — kept in sync with the
// patterns the MAIN-world interceptor uses so noise stays low. Exported for
// reference/tests; the interceptor embeds its own copy since it can't
// import modules.
export const CAPTURE_PATTERNS = {
  twitter: ["/graphql", "/i/api/graphql", "api.x.com"],
  linkedin: ["/voyager/api"],
  instagram: ["/api/v1/media", "/graphql/query", "/api/graphql"],
};
