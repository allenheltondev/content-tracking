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

// X (Twitter) ties a self-thread together by conversation_id_str: every
// tweet the author chains under their root carries the root's id there, and
// in_reply_to_status_id_str points at the tweet it continues. Collect every
// tweet a TweetDetail payload hydrates — keyed by id, deduped against the
// quoted/retweeted copies the walker also visits — so the extractor can roll
// a self-thread up onto its root (the URL the user tracks) while still
// emitting standalone tweets, and the user's lone reply inside someone
// else's thread, on their own.
function collectTwitterTweets(body) {
  const byId = new Map();
  walk(body, (node) => {
    const legacy = node.legacy;
    if (!legacy || typeof legacy.favorite_count !== "number") return;
    const id = node.rest_id || legacy.id_str || legacy.conversation_id_str;
    if (!id || byId.has(String(id))) return;

    const metrics = {};
    num(metrics, "likes", legacy.favorite_count);
    num(metrics, "reposts", legacy.retweet_count);
    num(metrics, "replies", legacy.reply_count);
    num(metrics, "quotes", legacy.quote_count);
    num(metrics, "bookmarks", legacy.bookmark_count);
    const views = pick(node.views?.count, node.ext_views?.count);
    if (views !== undefined) metrics.views = views;

    // user_id_str is the stable author id on the tweet's own legacy; the
    // core.user_results path is the GraphQL-native fallback if it's absent.
    const authorId =
      legacy.user_id_str ||
      node.core?.user_results?.result?.rest_id ||
      node.core?.user_results?.result?.legacy?.id_str ||
      null;

    byId.set(String(id), {
      id: String(id),
      conversationId: String(legacy.conversation_id_str || id),
      authorId: authorId != null ? String(authorId) : null,
      replyTo: legacy.in_reply_to_status_id_str
        ? String(legacy.in_reply_to_status_id_str)
        : null,
      metrics,
    });
  });
  return byId;
}

// Sum a self-thread's engagement onto one metrics object. Replies are the
// running sum minus the author's own continuation posts — each continuation
// shows up as a reply on its parent — leaving only replies from other people.
function sumTwitterThread(selfPosts) {
  const ids = new Set(selfPosts.map((t) => t.id));
  const totals = {};
  let continuations = 0;
  for (const t of selfPosts) {
    for (const key of ["likes", "reposts", "replies", "quotes", "bookmarks", "views"]) {
      if (typeof t.metrics[key] === "number") totals[key] = (totals[key] || 0) + t.metrics[key];
    }
    if (t.replyTo && ids.has(t.replyTo)) continuations += 1;
  }
  if (typeof totals.replies === "number") {
    totals.replies = Math.max(0, totals.replies - continuations);
  }
  return totals;
}

const twitter = {
  platform: "twitter",
  parsePostId(url) {
    const m = /\/status(?:es)?\/(\d+)/.exec(url || "");
    return m ? m[1] : null;
  },
  extract(body) {
    const byId = collectTwitterTweets(body);
    if (!byId.size) return [];
    const tweets = [...byId.values()];

    // Group by conversation. A conversation whose root tweet (id ===
    // conversation_id_str) is present and authored the same account as two or
    // more tweets in the group is a self-thread: roll it up onto the root.
    // Everything else — standalone posts, other users' replies, a lone reply
    // the user made in someone else's thread — keeps its own per-tweet row,
    // so the per-tweet sync path is preserved exactly when there's no thread.
    const byConversation = new Map();
    for (const t of tweets) {
      const group = byConversation.get(t.conversationId);
      if (group) group.push(t);
      else byConversation.set(t.conversationId, [t]);
    }

    const out = [];
    const rolledUp = new Set();
    const consumed = new Set();
    for (const [conversationId, group] of byConversation) {
      const root = byId.get(conversationId);
      if (!root || !root.authorId) continue;
      const selfPosts = group.filter((t) => t.authorId === root.authorId);
      if (selfPosts.length < 2) continue;

      const metrics = sumTwitterThread(selfPosts);
      if (!Object.keys(metrics).length) continue;
      out.push({ nativeId: conversationId, metrics });
      rolledUp.add(conversationId);
      for (const t of selfPosts) if (t.id !== conversationId) consumed.add(t.id);
    }

    for (const t of tweets) {
      if (rolledUp.has(t.id) || consumed.has(t.id)) continue;
      if (Object.keys(t.metrics).length) out.push({ nativeId: t.id, metrics: t.metrics });
    }
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

// Bluesky (bsky.app) addresses each post by an AT-URI of the form
// at://{did}/app.bsky.feed.post/{rkey}. The web permalink uses that same
// rkey as its trailing segment (bsky.app/profile/{handle|did}/post/{rkey}),
// so the rkey is the stable key that ties a tracked post's URL to the `uri`
// carried on every postView the AppView hands back.
const BSKY_POST_RE = /\/(?:app\.bsky\.feed\.)?post\/([^/?#]+)/;

// Sum a numeric postView count across posts, returning null when none of
// them carried it — so a shape that never reports e.g. bookmarkCount yields
// no "bookmarks" key rather than a misleading 0.
function sumBskyCount(posts, field) {
  let sum = 0;
  let present = false;
  for (const p of posts) {
    const v = p?.[field];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
      sum += v;
      present = true;
    }
  }
  return present ? sum : null;
}

// getPostThreadV2 (app.bsky.unspecced) hands back the anchor post plus the
// author's own thread continuation as a flat `thread` array of
// threadItemPost nodes. When a tracked post heads a self-thread (the author
// chained several posts under a 🧵), roll the whole thread up into one unit:
// sum each engagement across the author's posts and attribute the total to
// the anchor — the post URL the user registered. Replies need care: Bluesky
// counts each continuation post as a reply on its parent, so summing
// replyCount would count the author threading as engagement. Subtract every
// author post that is itself a reply to another post in the thread, leaving
// only genuine replies from other people.
function extractBlueskyThreadV2(items) {
  const anchorPost = (items.find((it) => (it?.depth ?? 0) === 0) || items[0])?.value
    ?.post;
  const anchorMatch =
    typeof anchorPost?.uri === "string" ? BSKY_POST_RE.exec(anchorPost.uri) : null;
  if (!anchorMatch) return [];
  const nativeId = anchorMatch[1];
  const anchorDid = anchorPost?.author?.did;

  // The author's posts in the thread: the anchor plus its self-reply
  // descendants. Guard on author so a stray non-OP item can't inflate the
  // totals, and on depth so any ancestors above the anchor are excluded.
  const opPosts = items
    .filter((it) => (it?.depth ?? 0) >= 0)
    .map((it) => it?.value?.post)
    .filter((p) => p && typeof p.uri === "string" && (!anchorDid || p.author?.did === anchorDid));
  if (!opPosts.length) return [];

  const opUris = new Set(opPosts.map((p) => p.uri));
  let continuations = 0;
  for (const p of opPosts) {
    const parentUri = p.record?.reply?.parent?.uri;
    if (parentUri && opUris.has(parentUri)) continuations += 1;
  }
  const replyTotal = sumBskyCount(opPosts, "replyCount");

  const metrics = {};
  num(metrics, "likes", sumBskyCount(opPosts, "likeCount"));
  num(metrics, "reposts", sumBskyCount(opPosts, "repostCount"));
  num(metrics, "quotes", sumBskyCount(opPosts, "quoteCount"));
  num(metrics, "bookmarks", sumBskyCount(opPosts, "bookmarkCount"));
  if (replyTotal !== null) num(metrics, "replies", Math.max(0, replyTotal - continuations));
  if (Object.keys(metrics).length === 0) return [];
  return [{ nativeId, metrics }];
}

const bluesky = {
  platform: "bluesky",
  parsePostId(url) {
    const m = BSKY_POST_RE.exec(url || "");
    return m ? m[1] : null;
  },
  extract(body) {
    // Single-post permalink view: getPostThreadV2 returns a flat thread
    // array. Roll the author's self-thread up onto the anchor post.
    if (Array.isArray(body?.thread) && body.thread.some((it) => it?.value?.post)) {
      return extractBlueskyThreadV2(body.thread);
    }

    // Feed/old-thread shapes: one row per post the payload hydrates.
    const out = [];
    const seen = new Set();
    walk(body, (node) => {
      // app.bsky.feed.defs#postView — and the #viewRecord embed a quote post
      // carries — pair the counts with the post's own AT-URI. Match on the
      // uri shape so we skip the like/repost/generator record uris that ride
      // along in the same payload (those aren't app.bsky.feed.post records).
      if (typeof node.uri !== "string") return;
      const m = BSKY_POST_RE.exec(node.uri);
      if (!m) return;
      const hasCounts =
        typeof node.likeCount === "number" ||
        typeof node.repostCount === "number" ||
        typeof node.replyCount === "number" ||
        typeof node.quoteCount === "number" ||
        typeof node.bookmarkCount === "number";
      if (!hasCounts) return;

      const nativeId = m[1];
      if (seen.has(nativeId)) return;

      const metrics = {};
      num(metrics, "likes", node.likeCount);
      num(metrics, "reposts", node.repostCount);
      num(metrics, "replies", node.replyCount);
      num(metrics, "quotes", node.quoteCount);
      num(metrics, "bookmarks", node.bookmarkCount);
      if (Object.keys(metrics).length === 0) return;

      seen.add(nativeId);
      out.push({ nativeId, metrics });
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

export const adapters = { twitter, linkedin, instagram, bluesky, medium, devto };

// Which Booked-side bucket each platform writes into. Drives the endpoint
// the background script PUTs to and the feed the extension fetches.
// Platforms not listed here default to the social bucket.
export const PLATFORM_BUCKET = {
  twitter: "social",
  linkedin: "social",
  instagram: "social",
  bluesky: "social",
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
  // Bluesky's web client reads post counts off the AppView's feed XRPC
  // calls (getAuthorFeed, getTimeline, getPosts, getFeed) plus the unspecced
  // thread endpoint a single-post permalink loads through (getPostThreadV2 /
  // getPostThreadOtherV2). All return hydrated postViews. Host varies
  // (public.api.bsky.app when logged out, the user's PDS proxy when logged
  // in) but these path prefixes are constant.
  bluesky: ["/xrpc/app.bsky.feed.", "/xrpc/app.bsky.unspecced.getPostThread"],
  // Medium's author-stats and per-post stats pages fetch from the
  // internal REST and GraphQL endpoints under medium.com/_/.
  medium: ["/_/api/", "/_/graphql"],
  // dev.to's analytics dashboard hits /api/analytics; per-article shapes
  // (with page_views_count, public_reactions_count) also show up on
  // /api/articles.
  devto: ["/api/analytics", "/api/articles"],
};
