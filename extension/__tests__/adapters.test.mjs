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
