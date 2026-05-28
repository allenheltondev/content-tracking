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

const medium = {
  platform: "medium",
  bucket: "content",
  parsePostId(url) {
    // /p/{id}     — Medium short-link form
    // /post/{id}  — author stats detail page (medium.com/me/stats/post/{id})
    const direct = /\/(?:p|post)\/([0-9a-f]+)/i.exec(url || "");
    if (direct) return direct[1].toLowerCase();
    // Public article URL ends in -{hex post id}, e.g.
    // /my-post-title-abc123def456. ≥6 chars to avoid matching short slug
    // tokens.
    const m = /-([0-9a-f]{6,})(?:[/?#]|$)/i.exec(url || "");
    return m ? m[1].toLowerCase() : null;
  },
  extract(body) {
    const out = [];
    const seen = new Set();
    const push = (id, metrics) => {
      if (!id || seen.has(id) || Object.keys(metrics).length === 0) return;
      seen.add(id);
      out.push({ nativeId: id, metrics });
    };
    walk(body, (node) => {
      // Per-post stats summary on the post-stats detail page. Counts live
      // on the bundle (viewersCount, readersCount, presentationCount); the
      // post id is one level down on the nested `post`. Match this shape
      // first so the inner Post node gets short-circuited by `seen`.
      if (
        typeof node.viewersCount === "number" ||
        typeof node.readersCount === "number" ||
        typeof node.presentationCount === "number"
      ) {
        const metrics = {};
        num(metrics, "views", node.viewersCount);
        num(metrics, "reads", node.readersCount);
        num(metrics, "impressions", node.presentationCount);
        push(node.post?.id, metrics);
        return;
      }

      // Post-typed nodes carry either nested `totalStats` (SummaryPostStat
      // on the author-stats GraphQL list) or flat fields (postResult's
      // `clapCount`, older REST stats responses). The __typename guard
      // keeps us off PostViewerEdge — which also has an id and a
      // clapCount, but that clapCount is the *viewer's* claps on the
      // post (almost always 0), not the post's total.
      if (node.__typename !== undefined && node.__typename !== "Post") return;

      const id = node.postId || node.post_id || node.id;
      if (typeof id !== "string" || !id) return;

      const stats = node.totalStats || node.stats || node;
      const hasStats =
        typeof stats.views === "number" ||
        typeof stats.reads === "number" ||
        typeof stats.presentations === "number" ||
        typeof stats.totalClapCount === "number" ||
        typeof stats.claps === "number" ||
        typeof stats.clapCount === "number" ||
        typeof stats.fans === "number" ||
        typeof stats.responsesCreatedCount === "number";
      if (!hasStats) return;

      const metrics = {};
      num(metrics, "views", stats.views);
      num(metrics, "reads", stats.reads);
      num(metrics, "impressions", stats.presentations);
      const claps = pick(stats.totalClapCount, stats.claps, stats.clapCount);
      if (claps !== undefined) metrics.claps = claps;
      const fans = pick(stats.fans, stats.fanCount, stats.uniqueClappers);
      if (fans !== undefined) metrics.fans = fans;
      const comments = pick(
        stats.responsesCreatedCount,
        stats.totalResponses,
        stats.responses,
        stats.commentsCount,
      );
      if (comments !== undefined) metrics.comments = comments;

      push(id, metrics);
    });
    return out;
  },
};

const devto = {
  platform: "devto",
  bucket: "content",
  parsePostId(url) {
    if (!url) return null;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    // Analytics dashboard URL: ?article_id={numeric id}. The article id
    // is dev.to's internal integer; the public slug uses its base36
    // form. Return base36 so the page-URL fallback matches what the slug
    // parser returns for the tracked post URL.
    const articleId = parsed.searchParams.get("article_id");
    if (articleId && /^\d+$/.test(articleId)) {
      return Number(articleId).toString(36);
    }
    // Article page URL: ends with -{base36 article id}. The per-post
    // stats page is just the article URL with /stats appended, which is
    // what auto-fires the analytics request — strip it so both URL forms
    // parse to the same id.
    const trimmed = parsed.pathname.replace(/\/$/, "").replace(/\/stats$/, "");
    const m = /-([0-9a-z]{1,8})$/.exec(trimmed);
    return m ? m[1] : null;
  },
  extract(body) {
    const out = [];
    const seen = new Set();

    // Analytics dashboard shape: { totals, historical, referrers, ... }.
    // `totals` and each `historical[date]` are structurally identical, so
    // a generic walker would emit a row for every day too — and since
    // the body has no article id, all those rows would race for the same
    // page-URL fallback target. Match the dashboard shape at the root
    // and pull from `totals` only; emit nativeId=null so background.js
    // resolves the target from the page URL's article_id query param.
    if (
      body && typeof body === "object" &&
      body.historical &&
      body.totals?.page_views &&
      typeof body.totals.page_views.total === "number"
    ) {
      const totals = body.totals;
      const metrics = {};
      num(metrics, "views", totals.page_views.total);
      num(metrics, "reactions", totals.reactions?.total);
      num(metrics, "comments", totals.comments?.total);
      if (Object.keys(metrics).length) {
        out.push({ nativeId: null, metrics });
      }
      return out;
    }

    // Article-record shape (/api/articles/{id} and similar): each node
    // carries the article id and flat *_count fields.
    walk(body, (node) => {
      const hasCounts =
        typeof node.page_views_count === "number" ||
        typeof node.public_reactions_count === "number" ||
        typeof node.positive_reactions_count === "number" ||
        typeof node.comments_count === "number";
      if (!hasCounts) return;

      // The id on dev.to API responses is a number; the URL embeds its
      // base36 representation. We emit the base36 form so the
      // background's URL-derived id matches without extra conversion.
      const rawId = node.id ?? node.article_id;
      const nativeId =
        typeof rawId === "number" && Number.isInteger(rawId)
          ? rawId.toString(36)
          : rawId != null
            ? String(rawId)
            : null;
      if (nativeId && seen.has(nativeId)) return;

      const metrics = {};
      num(metrics, "views", node.page_views_count);
      const reactions = pick(node.public_reactions_count, node.positive_reactions_count);
      if (reactions !== undefined) metrics.reactions = reactions;
      num(metrics, "comments", node.comments_count);

      if (Object.keys(metrics).length === 0) return;
      if (nativeId) seen.add(nativeId);
      out.push({ nativeId, metrics });
    });
    return out;
  },
};

export const adapters = { twitter, linkedin, instagram, medium, devto };

// Which Booked-side bucket each platform writes into. Drives the endpoint
// the background script PUTs to and the feed the extension fetches.
// Platforms not listed here default to the social bucket.
export const PLATFORM_BUCKET = {
  twitter: "social",
  linkedin: "social",
  instagram: "social",
  medium: "content",
  devto: "content",
};

// URL substrings worth capturing, per platform — kept in sync with the
// patterns the MAIN-world interceptor uses so noise stays low. Exported for
// reference/tests; the interceptor embeds its own copy since it can't
// import modules.
export const CAPTURE_PATTERNS = {
  twitter: ["/graphql", "/i/api/graphql", "api.x.com"],
  linkedin: ["/voyager/api"],
  instagram: ["/api/v1/media", "/graphql/query", "/api/graphql"],
  // Medium's author-stats and per-post stats pages fetch from the
  // internal REST and GraphQL endpoints under medium.com/_/.
  medium: ["/_/api/", "/_/graphql"],
  // dev.to's analytics dashboard hits /api/analytics; per-article shapes
  // (with page_views_count, public_reactions_count) also show up on
  // /api/articles.
  devto: ["/api/analytics", "/api/articles"],
};
