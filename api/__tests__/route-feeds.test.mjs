import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";

// Mock every collaborator so the route logic is exercised in isolation: the
// feed source store, the live aggregator, the Bedrock idea generator, and the
// voice/topics context reads.
jest.unstable_mockModule("../domain/feed.mjs", () => ({
  createFeedSource: jest.fn(),
  listFeedSources: jest.fn(),
  updateFeedSource: jest.fn(),
  deleteFeedSource: jest.fn(),
  recordFeedFetch: jest.fn(),
  getRadarPrefs: jest.fn(),
  putRadarPrefs: jest.fn(),
}));
jest.unstable_mockModule("../services/rss.mjs", () => ({
  aggregateFeeds: jest.fn(),
}));
jest.unstable_mockModule("../services/bedrock.mjs", () => ({
  suggestContentAngles: jest.fn(),
}));
jest.unstable_mockModule("../domain/voice.mjs", () => ({
  listProfiles: jest.fn(),
}));
jest.unstable_mockModule("../domain/content.mjs", () => ({
  listContentByTenant: jest.fn(),
}));

const {
  createFeedSource, listFeedSources, updateFeedSource, deleteFeedSource, recordFeedFetch,
  getRadarPrefs, putRadarPrefs,
} = await import("../domain/feed.mjs");
const { aggregateFeeds } = await import("../services/rss.mjs");
const { suggestContentAngles } = await import("../services/bedrock.mjs");
const { listProfiles } = await import("../domain/voice.mjs");
const { listContentByTenant } = await import("../domain/content.mjs");
const { registerFeedRoutes } = await import("../routes/feeds.mjs");

function buildRouteTable() {
  const routes = {};
  const app = {
    post: (path, handler) => { routes[`POST ${path}`] = handler; },
    get: (path, handler) => { routes[`GET ${path}`] = handler; },
    put: (path, handler) => { routes[`PUT ${path}`] = handler; },
    patch: (path, handler) => { routes[`PATCH ${path}`] = handler; },
    delete: (path, handler) => { routes[`DELETE ${path}`] = handler; },
  };
  registerFeedRoutes(app);
  return routes;
}

const routes = buildRouteTable();
const postFeed = routes["POST /content-radar/feeds"];
const getFeeds = routes["GET /content-radar/feeds"];
const patchFeed = routes["PATCH /content-radar/feeds/:feedId"];
const deleteFeed = routes["DELETE /content-radar/feeds/:feedId"];
const getFeed = routes["GET /content-radar/feed"];
const postIdeas = routes["POST /content-radar/ideas"];
const getPrefs = routes["GET /content-radar/preferences"];
const putPrefs = routes["PUT /content-radar/preferences"];

const AUTH = { requestContext: { authorizer: { authSource: "cognito", sub: "user-1" } } };

describe("routes/feeds", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    recordFeedFetch.mockResolvedValue(undefined);
    listProfiles.mockResolvedValue([]);
    listContentByTenant.mockResolvedValue({ items: [] });
    getRadarPrefs.mockResolvedValue(null);
  });

  test("registers all six routes", () => {
    for (const h of [postFeed, getFeeds, patchFeed, deleteFeed, getFeed, postIdeas]) {
      expect(typeof h).toBe("function");
    }
  });

  describe("POST /content-radar/feeds", () => {
    test("creates a source and returns 201", async () => {
      createFeedSource.mockResolvedValue({ feedId: "F1", url: "https://a.com/feed", title: "A", createdAt: "t", updatedAt: "t" });
      const res = await postFeed({ event: { body: JSON.stringify({ url: "https://a.com/feed", title: "A" }), ...AUTH } });
      expect(res.statusCode).toBe(201);
      expect(createFeedSource).toHaveBeenCalledWith("user-1", { url: "https://a.com/feed", title: "A" });
      expect(JSON.parse(res.body).feed_id).toBe("F1");
    });

    test("400 on a non-public url", async () => {
      await expect(postFeed({ event: { body: JSON.stringify({ url: "http://localhost/feed" }), ...AUTH } }))
        .rejects.toThrow(/public http/);
      expect(createFeedSource).not.toHaveBeenCalled();
    });
  });

  describe("GET /content-radar/feeds", () => {
    test("lists sources", async () => {
      listFeedSources.mockResolvedValue([{ feedId: "F1", url: "u", createdAt: "t" }]);
      const res = await getFeeds({ event: { ...AUTH } });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).feeds).toHaveLength(1);
    });
  });

  describe("PATCH /content-radar/feeds/:feedId", () => {
    test("updates and returns the source", async () => {
      updateFeedSource.mockResolvedValue({ feedId: "F1", url: "u", muted: true, updatedAt: "t" });
      const res = await patchFeed({ event: { body: JSON.stringify({ muted: true }), ...AUTH }, params: { feedId: "F1" } });
      expect(res.statusCode).toBe(200);
      expect(updateFeedSource).toHaveBeenCalledWith("user-1", "F1", { muted: true });
      expect(JSON.parse(res.body).muted).toBe(true);
    });
  });

  describe("DELETE /content-radar/feeds/:feedId", () => {
    test("deletes and returns 204", async () => {
      deleteFeedSource.mockResolvedValue(undefined);
      const res = await deleteFeed({ event: { ...AUTH }, params: { feedId: "F1" } });
      expect(res.statusCode).toBe(204);
      expect(deleteFeedSource).toHaveBeenCalledWith("user-1", "F1");
    });
  });

  describe("GET /content-radar/feed", () => {
    test("aggregates active sources and stamps health", async () => {
      listFeedSources.mockResolvedValue([
        { feedId: "F1", url: "https://a.com/feed" },
        { feedId: "F2", url: "https://b.com/feed", muted: true },
      ]);
      aggregateFeeds.mockResolvedValue({
        items: [{ title: "Item", link: "l", publishedAt: "2026-07-13T00:00:00.000Z", feedId: "F1", feedTitle: "A", sourceUrl: "u" }],
        results: [{ feedId: "F1", url: "https://a.com/feed", ok: true, itemCount: 1 }],
      });

      const res = await getFeed({ event: { ...AUTH, queryStringParameters: null } });
      expect(res.statusCode).toBe(200);
      // Only the non-muted source is passed to the aggregator.
      const passedSources = aggregateFeeds.mock.calls[0][0];
      expect(passedSources.map((s) => s.feedId)).toEqual(["F1"]);
      const body = JSON.parse(res.body);
      expect(body.items).toHaveLength(1);
      expect(body.sources).toHaveLength(1);
      expect(recordFeedFetch).toHaveBeenCalledWith("user-1", "F1", { ok: true, itemCount: 1, error: undefined });
    });

    test("short-circuits with an empty feed when there are no active sources", async () => {
      listFeedSources.mockResolvedValue([{ feedId: "F2", url: "u", muted: true }]);
      const res = await getFeed({ event: { ...AUTH, queryStringParameters: null } });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ items: [], sources: [] });
      expect(aggregateFeeds).not.toHaveBeenCalled();
    });
  });

  describe("POST /content-radar/ideas", () => {
    test("grounds the agent in feed items, voice, and topics", async () => {
      listFeedSources.mockResolvedValue([{ feedId: "F1", url: "https://a.com/feed" }]);
      aggregateFeeds.mockResolvedValue({
        items: [{ title: "AI news", summary: "s", feedTitle: "A", publishedAt: "2026-07-13T00:00:00.000Z" }],
        results: [{ feedId: "F1", url: "https://a.com/feed", ok: true, itemCount: 1 }],
      });
      listProfiles.mockResolvedValue([
        { platform: "blog", profile: { portrait: "You write blunt, example-first posts." } },
        { platform: "x", profile: {} }, // no portrait -> filtered out
      ]);
      listContentByTenant.mockResolvedValue({ items: [{ title: "My past post" }, { title: "  " }, {}] });
      suggestContentAngles.mockResolvedValue({
        summary: "AI agents are hot.",
        themes: [{ theme: "agents", momentum: "surging" }],
        angles: [{ title: "Why agents fail", angle: "take", rationale: "timely", sources: [1] }],
      });

      const res = await postIdeas({ event: { body: JSON.stringify({ platform: "blog", guidance: "be contrarian" }), ...AUTH } });

      expect(res.statusCode).toBe(200);
      const arg = suggestContentAngles.mock.calls[0][0];
      expect(arg.items).toHaveLength(1);
      expect(arg.platform).toBe("blog");
      expect(arg.guidance).toBe("be contrarian");
      // Only the profile with a portrait is passed.
      expect(arg.voicePortraits).toEqual([{ platform: "blog", portrait: "You write blunt, example-first posts." }]);
      // Only non-empty titles.
      expect(arg.recentTopics).toEqual(["My past post"]);

      const body = JSON.parse(res.body);
      expect(body.angles[0].title).toBe("Why agents fail");
      expect(body.sources).toHaveLength(1);
      // The feed items the agent read come back too, so an angle's [n]
      // citations resolve to the real backing article.
      expect(body.items).toHaveLength(1);
      expect(body.items[0].title).toBe("AI news");
    });

    test("restricts to feed_ids and excludes muted sources", async () => {
      listFeedSources.mockResolvedValue([
        { feedId: "F1", url: "https://a.com/feed" },
        { feedId: "F2", url: "https://b.com/feed" },
        { feedId: "F3", url: "https://c.com/feed", muted: true },
      ]);
      aggregateFeeds.mockResolvedValue({ items: [], results: [] });
      suggestContentAngles.mockResolvedValue({ summary: "none", angles: [] });

      await postIdeas({ event: { body: JSON.stringify({ feed_ids: ["F1", "F3"] }), ...AUTH } });

      const passed = aggregateFeeds.mock.calls[0][0].map((s) => s.feedId);
      // F1 requested + active; F3 requested but muted (excluded); F2 not requested.
      expect(passed).toEqual(["F1"]);
    });

    test("400 when there are no sources to read", async () => {
      listFeedSources.mockResolvedValue([]);
      await expect(postIdeas({ event: { body: null, ...AUTH } })).rejects.toThrow(/Add feeds/);
      expect(suggestContentAngles).not.toHaveBeenCalled();
    });

    test("still generates when voice and topics reads fail", async () => {
      listFeedSources.mockResolvedValue([{ feedId: "F1", url: "https://a.com/feed" }]);
      aggregateFeeds.mockResolvedValue({ items: [{ title: "x" }], results: [{ feedId: "F1", url: "u", ok: true, itemCount: 1 }] });
      listProfiles.mockRejectedValue(new Error("ddb down"));
      listContentByTenant.mockRejectedValue(new Error("ddb down"));
      suggestContentAngles.mockResolvedValue({ summary: "ok", angles: [] });

      const res = await postIdeas({ event: { body: null, ...AUTH } });
      expect(res.statusCode).toBe(200);
      const arg = suggestContentAngles.mock.calls[0][0];
      expect(arg.voicePortraits).toEqual([]);
      expect(arg.recentTopics).toEqual([]);
    });

    test("does not swallow a Bedrock failure", async () => {
      listFeedSources.mockResolvedValue([{ feedId: "F1", url: "https://a.com/feed" }]);
      aggregateFeeds.mockResolvedValue({ items: [{ title: "x" }], results: [] });
      suggestContentAngles.mockRejectedValue(new Error("bedrock boom"));
      await expect(postIdeas({ event: { body: null, ...AUTH } })).rejects.toThrow(/bedrock boom/);
    });

    test("feeds saved preferences into the agent and applies default platform/guidance", async () => {
      listFeedSources.mockResolvedValue([{ feedId: "F1", url: "https://a.com/feed" }]);
      aggregateFeeds.mockResolvedValue({ items: [{ title: "x" }], results: [] });
      getRadarPrefs.mockResolvedValue({
        interests: ["serverless"],
        avoid: ["crypto"],
        audience: "senior devs",
        defaultPlatform: "blog",
        defaultGuidance: "be contrarian",
      });
      suggestContentAngles.mockResolvedValue({ summary: "ok", angles: [] });

      await postIdeas({ event: { body: null, ...AUTH } });

      const arg = suggestContentAngles.mock.calls[0][0];
      expect(arg.interests).toEqual(["serverless"]);
      expect(arg.avoid).toEqual(["crypto"]);
      expect(arg.audience).toBe("senior devs");
      // Defaults apply when the request omits them.
      expect(arg.platform).toBe("blog");
      expect(arg.guidance).toBe("be contrarian");
    });

    test("request platform/guidance override the saved defaults", async () => {
      listFeedSources.mockResolvedValue([{ feedId: "F1", url: "https://a.com/feed" }]);
      aggregateFeeds.mockResolvedValue({ items: [{ title: "x" }], results: [] });
      getRadarPrefs.mockResolvedValue({ defaultPlatform: "blog", defaultGuidance: "default steer" });
      suggestContentAngles.mockResolvedValue({ summary: "ok", angles: [] });

      await postIdeas({ event: { body: JSON.stringify({ platform: "x", guidance: "override" }), ...AUTH } });

      const arg = suggestContentAngles.mock.calls[0][0];
      expect(arg.platform).toBe("x");
      expect(arg.guidance).toBe("override");
    });

    test("still generates when the preferences read fails", async () => {
      listFeedSources.mockResolvedValue([{ feedId: "F1", url: "https://a.com/feed" }]);
      aggregateFeeds.mockResolvedValue({ items: [{ title: "x" }], results: [] });
      getRadarPrefs.mockRejectedValue(new Error("ddb down"));
      suggestContentAngles.mockResolvedValue({ summary: "ok", angles: [] });

      const res = await postIdeas({ event: { body: null, ...AUTH } });
      expect(res.statusCode).toBe(200);
      const arg = suggestContentAngles.mock.calls[0][0];
      expect(arg.interests).toEqual([]);
      expect(arg.avoid).toEqual([]);
      expect(arg.audience).toBeNull();
    });
  });

  describe("preferences", () => {
    test("GET returns formatted prefs (defaults when unset)", async () => {
      getRadarPrefs.mockResolvedValue(null);
      const res = await getPrefs({ event: { ...AUTH } });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        interests: [], avoid: [], default_platform: null, default_guidance: null, audience: null, updated_at: null,
      });
    });

    test("PUT validates and saves, returning the formatted result", async () => {
      putRadarPrefs.mockResolvedValue({ interests: ["serverless"], defaultPlatform: "blog", updatedAt: "t" });
      const res = await putPrefs({ event: { body: JSON.stringify({ interests: ["serverless"], default_platform: "blog" }), ...AUTH } });
      expect(res.statusCode).toBe(200);
      expect(putRadarPrefs).toHaveBeenCalledWith("user-1", { interests: ["serverless"], defaultPlatform: "blog" });
      expect(JSON.parse(res.body).interests).toEqual(["serverless"]);
    });

    test("PUT 400 on an unknown default_platform", async () => {
      await expect(putPrefs({ event: { body: JSON.stringify({ default_platform: "myspace" }), ...AUTH } }))
        .rejects.toThrow(/default_platform/);
      expect(putRadarPrefs).not.toHaveBeenCalled();
    });
  });
});
