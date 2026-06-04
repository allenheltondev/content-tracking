import { adapters } from "../src/adapters.js";

describe("twitter adapter", () => {
  test("parsePostId pulls the status id", () => {
    expect(adapters.twitter.parsePostId("https://x.com/foo/status/1790000000000000001")).toBe(
      "1790000000000000001",
    );
    expect(adapters.twitter.parsePostId("https://example.com/foo")).toBeNull();
  });

  test("extract reads counts from a TweetDetail-shaped payload", () => {
    const body = {
      data: {
        tweetResult: {
          result: {
            rest_id: "1790000000000000001",
            views: { count: "12345" },
            legacy: {
              favorite_count: 50,
              retweet_count: 7,
              reply_count: 3,
              quote_count: 1,
              bookmark_count: 9,
              id_str: "1790000000000000001",
            },
          },
        },
      },
    };
    const out = adapters.twitter.extract(body);
    expect(out).toEqual([
      {
        nativeId: "1790000000000000001",
        metrics: { likes: 50, reposts: 7, replies: 3, quotes: 1, bookmarks: 9, views: 12345 },
      },
    ]);
  });

  // Build a TweetDetail-ish tweet_results.result node. Counts are only set
  // when passed (X's num() emits 0s, so omitting keeps test expectations to
  // just the metrics each case exercises). conversation_id_str + replyTo are
  // the rollup keys; favorite_count is required for the node to count.
  const tweetNode = ({ id, conv, author, replyTo, likes, rts, replies, quotes, bookmarks, views }) => {
    const legacy = { id_str: id, conversation_id_str: conv, user_id_str: author };
    if (likes != null) legacy.favorite_count = likes;
    if (rts != null) legacy.retweet_count = rts;
    if (replies != null) legacy.reply_count = replies;
    if (quotes != null) legacy.quote_count = quotes;
    if (bookmarks != null) legacy.bookmark_count = bookmarks;
    if (replyTo) legacy.in_reply_to_status_id_str = replyTo;
    return {
      rest_id: id,
      ...(views != null ? { views: { count: String(views) } } : {}),
      core: { user_results: { result: { rest_id: author } } },
      legacy,
    };
  };

  // Wrap result nodes in a timeline-ish envelope so the walker reaches them
  // the way it would in a real threaded_conversation payload.
  const timeline = (...results) => ({
    data: {
      threaded_conversation: {
        instructions: [
          { entries: results.map((r) => ({ content: { itemContent: { tweet_results: { result: r } } } })) },
        ],
      },
    },
  });

  test("extract rolls a self-thread up onto the root tweet", () => {
    const body = timeline(
      tweetNode({ id: "100", conv: "100", author: "u1", likes: 50, rts: 7, replies: 1, quotes: 1, bookmarks: 9, views: 1000 }),
      tweetNode({ id: "101", conv: "100", author: "u1", replyTo: "100", likes: 5, replies: 1, views: 200 }),
      tweetNode({ id: "102", conv: "100", author: "u1", replyTo: "101", likes: 3, replies: 0, views: 100 }),
    );
    // likes 50+5+3=58, reposts 7, quotes 1, bookmarks 9, views 1300.
    // replyTotal 1+1+0=2, both continuations (101→100, 102→101) → replies 0.
    expect(adapters.twitter.extract(body)).toEqual([
      {
        nativeId: "100",
        metrics: { likes: 58, reposts: 7, replies: 0, quotes: 1, bookmarks: 9, views: 1300 },
      },
    ]);
  });

  test("extract keeps genuine replies and other authors out of the thread sum", () => {
    const body = timeline(
      tweetNode({ id: "100", conv: "100", author: "u1", likes: 50, replies: 2, views: 1000 }),
      tweetNode({ id: "101", conv: "100", author: "u1", replyTo: "100", likes: 5, replies: 0, views: 200 }),
      // Someone else's reply in the same conversation — own row, not summed.
      tweetNode({ id: "900", conv: "100", author: "u2", replyTo: "100", likes: 4 }),
    );
    // u1 thread: likes 55, views 1200; replyTotal 2+0=2, one continuation
    // (101→100) → replies 1.
    expect(adapters.twitter.extract(body)).toEqual([
      { nativeId: "100", metrics: { likes: 55, replies: 1, views: 1200 } },
      { nativeId: "900", metrics: { likes: 4 } },
    ]);
  });

  test("extract leaves a lone reply in someone else's thread on its own row", () => {
    const body = timeline(
      // Another account's root, threaded by them — rolls up to their id.
      tweetNode({ id: "500", conv: "500", author: "u2", likes: 100, replies: 1 }),
      tweetNode({ id: "501", conv: "500", author: "u2", replyTo: "500", likes: 20, replies: 1 }),
      // The user's single reply into that thread — tracked by id 600.
      tweetNode({ id: "600", conv: "500", author: "u1", replyTo: "501", likes: 8 }),
    );
    const out = adapters.twitter.extract(body);
    expect(out).toContainEqual({ nativeId: "600", metrics: { likes: 8 } });
    // u2's thread rolled up onto its root, not onto the user's reply.
    expect(out).toContainEqual({ nativeId: "500", metrics: { likes: 120, replies: 1 } });
  });
});

describe("linkedin adapter", () => {
  test("parsePostId handles activity urns and slugged urls", () => {
    expect(
      adapters.linkedin.parsePostId(
        "https://www.linkedin.com/feed/update/urn:li:activity:7190000000000000000/",
      ),
    ).toBe("7190000000000000000");
    expect(
      adapters.linkedin.parsePostId(
        "https://www.linkedin.com/posts/someone_slug-activity-7190000000000000001-abcd",
      ),
    ).toBe("7190000000000000001");
  });

  test("extract reads totalSocialActivityCounts and resolves the activity id", () => {
    const body = {
      data: {
        socialDetail: {
          urn: "urn:li:activity:7190000000000000000",
          totalSocialActivityCounts: {
            numLikes: 120,
            numComments: 14,
            numShares: 6,
            numImpressions: 9000,
          },
        },
      },
    };
    const out = adapters.linkedin.extract(body);
    expect(out).toEqual([
      {
        nativeId: "7190000000000000000",
        metrics: { likes: 120, comments: 14, reposts: 6, impressions: 9000 },
      },
    ]);
  });

  test("extract yields a null nativeId when no urn is present (page fallback)", () => {
    const out = adapters.linkedin.extract({ totalSocialActivityCounts: { numLikes: 5 } });
    expect(out).toEqual([{ nativeId: null, metrics: { likes: 5 } }]);
  });
});

describe("instagram adapter", () => {
  test("parsePostId reads the shortcode from p/ and reel/ urls", () => {
    expect(adapters.instagram.parsePostId("https://www.instagram.com/p/CabcDEF123/")).toBe(
      "CabcDEF123",
    );
    expect(adapters.instagram.parsePostId("https://www.instagram.com/reel/XyZ987/")).toBe("XyZ987");
  });

  test("extract reads a REST media item", () => {
    const body = {
      items: [{ code: "CabcDEF123", like_count: 200, comment_count: 12, play_count: 5000 }],
    };
    expect(adapters.instagram.extract(body)).toEqual([
      { nativeId: "CabcDEF123", metrics: { likes: 200, comments: 12, views: 5000 } },
    ]);
  });

  test("extract reads a GraphQL shortcode_media node", () => {
    const body = {
      data: {
        xdt_shortcode_media: {
          shortcode: "CabcDEF123",
          edge_media_preview_like: { count: 200 },
          edge_media_to_parent_comment: { count: 12 },
          video_view_count: 5000,
        },
      },
    };
    expect(adapters.instagram.extract(body)).toEqual([
      { nativeId: "CabcDEF123", metrics: { likes: 200, comments: 12, views: 5000 } },
    ]);
  });
});

describe("bluesky adapter", () => {
  test("parsePostId reads the rkey from web permalinks and at-uris", () => {
    expect(
      adapters.bluesky.parsePostId(
        "https://bsky.app/profile/allen.bsky.social/post/3kj2lxyz7s2k",
      ),
    ).toBe("3kj2lxyz7s2k");
    // did-based permalink form.
    expect(
      adapters.bluesky.parsePostId(
        "https://bsky.app/profile/did:plc:abc123/post/3kj2lxyz7s2k",
      ),
    ).toBe("3kj2lxyz7s2k");
    // Raw AT-URI (the form carried on every postView).
    expect(
      adapters.bluesky.parsePostId("at://did:plc:abc123/app.bsky.feed.post/3kj2lxyz7s2k"),
    ).toBe("3kj2lxyz7s2k");
    expect(adapters.bluesky.parsePostId("https://bsky.app/profile/allen.bsky.social")).toBeNull();
  });

  test("extract reads a getPostThread-shaped payload", () => {
    const body = {
      thread: {
        $type: "app.bsky.feed.defs#threadViewPost",
        post: {
          uri: "at://did:plc:abc123/app.bsky.feed.post/3kj2lxyz7s2k",
          cid: "bafyreigh2akiscaildc",
          author: { did: "did:plc:abc123", handle: "allen.bsky.social" },
          replyCount: 3,
          repostCount: 7,
          likeCount: 50,
          quoteCount: 1,
          indexedAt: "2026-06-01T00:00:00.000Z",
          // The viewer's own like record rides along but is a like-record
          // uri, not a post — it must not be emitted as a second row.
          viewer: { like: "at://did:plc:me/app.bsky.feed.like/xyz" },
        },
        replies: [],
      },
    };
    expect(adapters.bluesky.extract(body)).toEqual([
      {
        nativeId: "3kj2lxyz7s2k",
        metrics: { likes: 50, reposts: 7, replies: 3, quotes: 1 },
      },
    ]);
  });

  test("extract reads the anchor post in a getPostThreadV2-shaped payload", () => {
    // The single-post permalink view loads through app.bsky.unspecced.
    // getPostThreadV2, whose `thread` is a flat array of items. Each item
    // wraps its postView under `value.post`; the outer item carries the
    // same at-uri but no counts, so it must not double-emit.
    const body = {
      thread: [
        {
          uri: "at://did:plc:abc123/app.bsky.feed.post/3kj2lxyz7s2k",
          depth: 0,
          value: {
            $type: "app.bsky.unspecced.defs#threadItemPost",
            post: {
              uri: "at://did:plc:abc123/app.bsky.feed.post/3kj2lxyz7s2k",
              cid: "bafyreigh2akiscaildc",
              author: { did: "did:plc:abc123", handle: "allen.bsky.social" },
              replyCount: 3,
              repostCount: 7,
              likeCount: 50,
              quoteCount: 1,
              indexedAt: "2026-06-01T00:00:00.000Z",
            },
          },
        },
      ],
      hasOtherReplies: false,
    };
    expect(adapters.bluesky.extract(body)).toEqual([
      {
        nativeId: "3kj2lxyz7s2k",
        metrics: { likes: 50, reposts: 7, replies: 3, quotes: 1 },
      },
    ]);
  });

  test("extract sums a self-thread onto the anchor and drops self-replies", () => {
    // Faithful trim of a real 7-post 🧵: every post is the author's own,
    // each replying to the previous. Engagement totals onto the anchor;
    // every replyCount is the author continuing the thread, so the genuine
    // reply count is zero.
    const DID = "did:plc:aqtn3pn3dk4kd76fleosrrxb";
    const uri = (rkey) => `at://${DID}/app.bsky.feed.post/${rkey}`;
    const item = (rkey, parentRkey, counts, depth) => ({
      uri: uri(rkey),
      depth,
      value: {
        $type: "app.bsky.unspecced.defs#threadItemPost",
        opThread: true,
        post: {
          uri: uri(rkey),
          author: { did: DID, handle: "readysetcloud.io" },
          record: parentRkey
            ? { reply: { parent: { uri: uri(parentRkey) }, root: { uri: uri("3mlszz4pbz22x") } } }
            : {},
          bookmarkCount: 0,
          repostCount: 0,
          quoteCount: 0,
          ...counts,
        },
      },
    });
    const body = {
      hasOtherReplies: false,
      thread: [
        item("3mlszz4pbz22x", null, { replyCount: 1, likeCount: 1 }, 0),
        item("3mlszz4pits2x", "3mlszz4pbz22x", { replyCount: 1, likeCount: 0 }, 1),
        item("3mlszz4pksc2x", "3mlszz4pits2x", { replyCount: 1, likeCount: 0 }, 2),
        item("3mlszz4plrk2x", "3mlszz4pksc2x", { replyCount: 1, likeCount: 0 }, 3),
        item("3mlszz4plrl2x", "3mlszz4plrk2x", { replyCount: 1, likeCount: 0 }, 4),
        item("3mlszz4pmqt2x", "3mlszz4plrl2x", { replyCount: 1, likeCount: 1 }, 5),
        item("3mlszz4pmqu2x", "3mlszz4pmqt2x", { replyCount: 0, likeCount: 1 }, 6),
      ],
    };
    expect(adapters.bluesky.extract(body)).toEqual([
      {
        nativeId: "3mlszz4pbz22x",
        metrics: { likes: 3, reposts: 0, quotes: 0, bookmarks: 0, replies: 0 },
      },
    ]);
  });

  test("extract keeps genuine replies when summing a self-thread", () => {
    // Anchor's replyCount is 2: one is the author's continuation (bbb), the
    // other a real reply from someone else — only the real one survives.
    const DID = "did:plc:op";
    const uri = (rkey) => `at://${DID}/app.bsky.feed.post/${rkey}`;
    const body = {
      thread: [
        {
          uri: uri("aaa"),
          depth: 0,
          value: {
            opThread: true,
            post: {
              uri: uri("aaa"),
              author: { did: DID },
              record: {},
              likeCount: 1,
              repostCount: 0,
              quoteCount: 0,
              bookmarkCount: 1,
              replyCount: 2,
            },
          },
        },
        {
          uri: uri("bbb"),
          depth: 1,
          value: {
            opThread: true,
            post: {
              uri: uri("bbb"),
              author: { did: DID },
              record: { reply: { parent: { uri: uri("aaa") }, root: { uri: uri("aaa") } } },
              likeCount: 0,
              repostCount: 0,
              quoteCount: 0,
              bookmarkCount: 0,
              replyCount: 0,
            },
          },
        },
      ],
    };
    expect(adapters.bluesky.extract(body)).toEqual([
      {
        nativeId: "aaa",
        metrics: { likes: 1, reposts: 0, quotes: 0, bookmarks: 1, replies: 1 },
      },
    ]);
  });

  test("extract reads each post in a getAuthorFeed-shaped payload", () => {
    const body = {
      feed: [
        {
          post: {
            uri: "at://did:plc:abc123/app.bsky.feed.post/aaaaaaaaaaaa",
            replyCount: 1,
            repostCount: 2,
            likeCount: 10,
            quoteCount: 0,
          },
        },
        {
          post: {
            uri: "at://did:plc:abc123/app.bsky.feed.post/bbbbbbbbbbbb",
            replyCount: 0,
            repostCount: 0,
            likeCount: 4,
            quoteCount: 0,
          },
          reason: { $type: "app.bsky.feed.defs#reasonRepost" },
        },
      ],
    };
    expect(adapters.bluesky.extract(body)).toEqual([
      { nativeId: "aaaaaaaaaaaa", metrics: { likes: 10, reposts: 2, replies: 1, quotes: 0 } },
      { nativeId: "bbbbbbbbbbbb", metrics: { likes: 4, reposts: 0, replies: 0, quotes: 0 } },
    ]);
  });

  test("extract ignores feed-generator views that carry a likeCount", () => {
    // Feed generators are liked too, but their uri is an app.bsky.feed.generator
    // record — not a post — so they must not be mistaken for tracked posts.
    const body = {
      feeds: [
        {
          uri: "at://did:plc:abc123/app.bsky.feed.generator/whats-hot",
          likeCount: 9001,
          displayName: "What's Hot",
        },
      ],
    };
    expect(adapters.bluesky.extract(body)).toEqual([]);
  });
});

describe("medium adapter", () => {
  test("parsePostId pulls the trailing hex post id", () => {
    expect(
      adapters.medium.parsePostId("https://medium.com/@allen/my-post-title-abc123def456"),
    ).toBe("abc123def456");
    expect(
      adapters.medium.parsePostId("https://allen.medium.com/my-post-title-abc123def456"),
    ).toBe("abc123def456");
    expect(adapters.medium.parsePostId("https://medium.com/p/AbC123dEf")).toBe("abc123def");
    // Author per-post stats page — id lives directly after /post/.
    expect(adapters.medium.parsePostId("https://medium.com/me/stats/post/d2d3830625c4")).toBe(
      "d2d3830625c4",
    );
    expect(adapters.medium.parsePostId("https://medium.com/@allen/no-id-here")).toBeNull();
  });

  test("extract reads the GraphQL userPostsConnection totalStats shape", () => {
    // Real shape from the author-stats GraphQL query:
    // postsConnection.edges[].node.totalStats = SummaryPostStat.
    const body = {
      data: {
        user: {
          postsConnection: {
            edges: [
              {
                node: {
                  id: "d2d3830625c4",
                  title: "Your agent is repeating itself",
                  totalStats: { presentations: 1625, views: 43, reads: 11 },
                  mediumUrl:
                    "https://allenheltondev.medium.com/your-agent-is-repeating-itself-d2d3830625c4",
                },
              },
              {
                node: {
                  id: "0692f8616308",
                  totalStats: { presentations: 2048, views: 91, reads: 43 },
                },
              },
            ],
          },
        },
      },
    };
    const out = adapters.medium.extract(body);
    expect(out).toEqual([
      {
        nativeId: "d2d3830625c4",
        metrics: { views: 43, reads: 11, impressions: 1625 },
      },
      {
        nativeId: "0692f8616308",
        metrics: { views: 91, reads: 43, impressions: 2048 },
      },
    ]);
  });

  test("extract reads postStatsTotalBundle on the per-post stats page", () => {
    const body = {
      data: {
        postStatsTotalBundle: {
          post: { id: "d2d3830625c4", __typename: "Post" },
          readersCount: 11,
          viewersCount: 43,
          feedClickThroughRate: null,
          presentationCount: 1625,
          __typename: "PostStatsTotalBundle",
        },
      },
    };
    expect(adapters.medium.extract(body)).toEqual([
      {
        nativeId: "d2d3830625c4",
        metrics: { views: 43, reads: 11, impressions: 1625 },
      },
    ]);
  });

  test("extract reads postResult clapCount but ignores viewerEdge clapCount", () => {
    // Real shape: same array can carry the post's own clap total AND the
    // viewer's personal clap count under PostViewerEdge. We want the
    // former (post.clapCount = 11) and must not emit the latter as a
    // second row with a synthetic id.
    const body = [
      {
        data: {
          postResult: { __typename: "Post", id: "d2d3830625c4", clapCount: 11 },
        },
      },
      {
        data: {
          post: {
            id: "d2d3830625c4",
            __typename: "Post",
            viewerEdge: {
              __typename: "PostViewerEdge",
              id: "postId:d2d3830625c4-viewerId:506242edfbaf",
              clapCount: 0,
            },
          },
        },
      },
    ];
    expect(adapters.medium.extract(body)).toEqual([
      { nativeId: "d2d3830625c4", metrics: { claps: 11 } },
    ]);
  });

  test("extract still reads the flat REST stats shape", () => {
    const body = {
      payload: {
        value: [
          {
            postId: "abc123def456",
            views: 1200,
            reads: 480,
            totalClapCount: 95,
            fans: 60,
            responsesCreatedCount: 4,
          },
        ],
      },
    };
    expect(adapters.medium.extract(body)).toEqual([
      {
        nativeId: "abc123def456",
        metrics: { views: 1200, reads: 480, claps: 95, fans: 60, comments: 4 },
      },
    ]);
  });

  test("extract ignores nodes that lack stats counts", () => {
    const body = { data: { post: { id: "abc123def456", title: "Hello" } } };
    expect(adapters.medium.extract(body)).toEqual([]);
  });
});

describe("devto adapter", () => {
  test("parsePostId reads the trailing base36 id from the slug", () => {
    expect(adapters.devto.parsePostId("https://dev.to/allen/my-cool-post-fjm0")).toBe("fjm0");
    expect(adapters.devto.parsePostId("https://dev.to/allen/short-1abc/")).toBe("1abc");
    expect(adapters.devto.parsePostId("https://dev.to/allen")).toBeNull();
  });

  test("parsePostId strips the per-post /stats suffix so both URL forms parse to the same id", () => {
    expect(
      adapters.devto.parsePostId(
        "https://dev.to/allenheltondev/your-ai-agents-are-a-security-nightmare-4omp",
      ),
    ).toBe("4omp");
    expect(
      adapters.devto.parsePostId(
        "https://dev.to/allenheltondev/your-ai-agents-are-a-security-nightmare-4omp/stats",
      ),
    ).toBe("4omp");
  });

  test("parsePostId converts the dashboard URL's article_id to base36", () => {
    // The dashboard URL carries the numeric id; the public slug uses the
    // base36 form. Returning base36 lets the page-URL fallback in
    // background.js match a tracked post registered by slug.
    expect(
      adapters.devto.parsePostId(
        "https://dev.to/dashboard/analytics?start=2026-05-21&article_id=3415690",
      ),
    ).toBe((3415690).toString(36));
  });

  test("extract reads an article shape with page_views_count", () => {
    const body = [
      {
        id: 2247580,
        page_views_count: 800,
        public_reactions_count: 42,
        comments_count: 5,
      },
    ];
    expect(adapters.devto.extract(body)).toEqual([
      {
        // 2247580 in base36 is "1cs6c" — matches the trailing slug segment.
        nativeId: (2247580).toString(36),
        metrics: { views: 800, reactions: 42, comments: 5 },
      },
    ]);
  });

  test("extract pulls the dashboard totals once, ignoring the historical daily rows", () => {
    // Real shape from /api/analytics/dashboard?article_id=...&start=...
    // `totals` and each `historical[date]` are structurally identical;
    // we want exactly one emission, from `totals`. Article id isn't in
    // the body so we emit nativeId=null and let the page-URL fallback
    // resolve the target.
    const body = {
      historical: {
        "2026-05-21": {
          comments: { total: 0 },
          reactions: { total: 0 },
          page_views: { total: 0 },
        },
        "2026-05-22": {
          comments: { total: 0 },
          reactions: { total: 0 },
          page_views: { total: 0 },
        },
      },
      totals: {
        comments: { total: 1 },
        follows: { total: 4138 },
        reactions: { total: 3, like: 2, fire: 1, unique_reactors: 3 },
        page_views: {
          total: 74,
          average_read_time_in_seconds: 252,
          total_read_time_in_seconds: 18648,
        },
      },
      referrers: { domains: [] },
    };
    expect(adapters.devto.extract(body)).toEqual([
      { nativeId: null, metrics: { views: 74, reactions: 3, comments: 1 } },
    ]);
  });

  test("extract emits a null nativeId when the id is absent (page fallback)", () => {
    const body = { page_views_count: 800 };
    expect(adapters.devto.extract(body)).toEqual([
      { nativeId: null, metrics: { views: 800 } },
    ]);
  });
});
