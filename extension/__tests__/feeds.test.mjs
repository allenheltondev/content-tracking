import {
  normalizeDiscoveredFeeds,
  resolveFeedUrl,
  feedUrlKey,
  sameFeed,
} from "../src/feeds.js";

const BASE = "https://blog.example.com/posts/hello-world";

describe("resolveFeedUrl", () => {
  test("resolves a relative href against the page URL", () => {
    expect(resolveFeedUrl("/feed.xml", BASE)).toBe("https://blog.example.com/feed.xml");
    expect(resolveFeedUrl("feed", BASE)).toBe("https://blog.example.com/posts/feed");
  });

  test("keeps an absolute http(s) href", () => {
    expect(resolveFeedUrl("https://cdn.example.com/rss", BASE)).toBe(
      "https://cdn.example.com/rss",
    );
  });

  test("rejects non-http(s) and empty hrefs", () => {
    expect(resolveFeedUrl("javascript:alert(1)", BASE)).toBeNull();
    expect(resolveFeedUrl("data:text/xml,<rss/>", BASE)).toBeNull();
    expect(resolveFeedUrl("", BASE)).toBeNull();
    expect(resolveFeedUrl(null, BASE)).toBeNull();
  });
});

describe("feedUrlKey / sameFeed", () => {
  test("ignores trailing slash, fragment, and host case", () => {
    expect(sameFeed("https://Example.com/feed/", "https://example.com/feed")).toBe(true);
    expect(sameFeed("https://example.com/feed#top", "https://example.com/feed")).toBe(true);
  });

  test("treats a different path or query as a different feed", () => {
    expect(sameFeed("https://example.com/feed", "https://example.com/rss")).toBe(false);
    expect(sameFeed("https://example.com/feed?a=1", "https://example.com/feed")).toBe(false);
  });

  test("empty / unparseable keys never match", () => {
    expect(sameFeed("", "")).toBe(false);
    expect(feedUrlKey("not a url")).toBe("not a url");
  });
});

describe("normalizeDiscoveredFeeds", () => {
  test("keeps only rss/atom alternate links and resolves relative hrefs", () => {
    const { feeds } = normalizeDiscoveredFeeds({
      baseUrl: BASE,
      pageTitle: "Hello World | Example Blog",
      siteName: "Example Blog",
      links: [
        { rel: "alternate", type: "application/rss+xml", href: "/feed.xml", title: "Example RSS" },
        { rel: "alternate", type: "application/atom+xml", href: "https://blog.example.com/atom" },
        // Not a feed: an alternate-language HTML page.
        { rel: "alternate", type: "text/html", href: "/es/", title: "Spanish" },
        // Not alternate at all.
        { rel: "stylesheet", type: "text/css", href: "/app.css" },
      ],
    });
    expect(feeds).toEqual([
      { url: "https://blog.example.com/feed.xml", title: "Example RSS", kind: "rss" },
      { url: "https://blog.example.com/atom", title: "Example Blog", kind: "atom" },
    ]);
  });

  test("dedupes feeds that resolve to the same URL", () => {
    const { feeds } = normalizeDiscoveredFeeds({
      baseUrl: BASE,
      links: [
        { rel: "alternate", type: "application/rss+xml", href: "/feed" },
        { rel: "alternate", type: "application/rss+xml", href: "https://blog.example.com/feed/" },
      ],
    });
    expect(feeds).toHaveLength(1);
    expect(feeds[0].url).toBe("https://blog.example.com/feed");
  });

  test("handles a space-separated rel token list", () => {
    const { feeds } = normalizeDiscoveredFeeds({
      baseUrl: BASE,
      links: [
        { rel: "alternate home", type: "application/rss+xml", href: "/feed" },
      ],
    });
    expect(feeds).toHaveLength(1);
  });

  test("falls back to site title, then URL, when a feed link has no title", () => {
    const withSite = normalizeDiscoveredFeeds({
      baseUrl: BASE,
      siteName: "Example Blog",
      links: [{ rel: "alternate", type: "application/rss+xml", href: "/feed" }],
    });
    expect(withSite.feeds[0].title).toBe("Example Blog");
    expect(withSite.siteTitle).toBe("Example Blog");

    const noSite = normalizeDiscoveredFeeds({
      baseUrl: BASE,
      links: [{ rel: "alternate", type: "application/rss+xml", href: "/feed" }],
    });
    expect(noSite.feeds[0].title).toBe("https://blog.example.com/feed");
  });

  test("drops javascript:/data: feed hrefs", () => {
    const { feeds } = normalizeDiscoveredFeeds({
      baseUrl: BASE,
      links: [
        { rel: "alternate", type: "application/rss+xml", href: "javascript:alert(1)" },
        { rel: "alternate", type: "application/atom+xml", href: "/ok" },
      ],
    });
    expect(feeds).toEqual([
      { url: "https://blog.example.com/ok", title: "https://blog.example.com/ok", kind: "atom" },
    ]);
  });

  test("returns an empty list for missing or non-array links", () => {
    expect(normalizeDiscoveredFeeds({ baseUrl: BASE }).feeds).toEqual([]);
    expect(normalizeDiscoveredFeeds({}).feeds).toEqual([]);
    expect(normalizeDiscoveredFeeds().feeds).toEqual([]);
  });
});
