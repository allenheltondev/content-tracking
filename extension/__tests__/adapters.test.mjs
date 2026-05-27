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
