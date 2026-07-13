import { jest } from "@jest/globals";

const { parseFeed, fetchFeed, aggregateFeeds } = await import("../services/rss.mjs");

const RSS_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Ready Set Cloud</title>
    <link>https://www.readysetcloud.io</link>
    <description>A blog about serverless</description>
    <item>
      <title><![CDATA[Event-driven all the things]]></title>
      <link>https://www.readysetcloud.io/blog/event-driven</link>
      <description>&lt;p&gt;Why events beat requests &amp;amp; polling.&lt;/p&gt;</description>
      <pubDate>Mon, 06 Jul 2026 12:00:00 GMT</pubDate>
      <dc:creator>Allen</dc:creator>
      <guid>https://www.readysetcloud.io/blog/event-driven</guid>
    </item>
    <item>
      <title>Step Functions patterns</title>
      <link>https://www.readysetcloud.io/blog/sfn</link>
      <content:encoded><![CDATA[<h1>Patterns</h1><p>The full body here.</p>]]></content:encoded>
      <pubDate>Tue, 07 Jul 2026 09:30:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

const ATOM_SAMPLE = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Weekly</title>
  <entry>
    <title>Serverless in 2026</title>
    <link rel="self" href="https://example.com/api/1"/>
    <link rel="alternate" href="https://example.com/posts/serverless-2026"/>
    <summary>What changed this year.</summary>
    <published>2026-07-05T08:00:00Z</published>
    <updated>2026-07-06T08:00:00Z</updated>
    <id>tag:example.com,2026:1</id>
    <author><name>Jane Doe</name></author>
  </entry>
</feed>`;

describe("services/rss parseFeed", () => {
  test("parses RSS 2.0 items with CDATA, entities, and content:encoded", () => {
    const parsed = parseFeed(RSS_SAMPLE);
    expect(parsed.feedTitle).toBe("Ready Set Cloud");
    expect(parsed.items).toHaveLength(2);

    const [first, second] = parsed.items;
    expect(first.title).toBe("Event-driven all the things");
    expect(first.link).toBe("https://www.readysetcloud.io/blog/event-driven");
    // HTML stripped, entities decoded (&amp;amp; -> &).
    expect(first.summary).toBe("Why events beat requests & polling.");
    expect(first.author).toBe("Allen");
    expect(first.publishedAt).toBe("2026-07-06T12:00:00.000Z");
    expect(first.guid).toBe("https://www.readysetcloud.io/blog/event-driven");

    // Falls back to content:encoded for the summary, HTML stripped.
    expect(second.summary).toContain("The full body here.");
    expect(second.summary).not.toContain("<h1>");
  });

  test("parses Atom entries and prefers the alternate link", () => {
    const parsed = parseFeed(ATOM_SAMPLE);
    expect(parsed.feedTitle).toBe("Atom Weekly");
    expect(parsed.items).toHaveLength(1);

    const item = parsed.items[0];
    expect(item.title).toBe("Serverless in 2026");
    // rel="alternate" wins over rel="self".
    expect(item.link).toBe("https://example.com/posts/serverless-2026");
    expect(item.summary).toBe("What changed this year.");
    expect(item.author).toBe("Jane Doe");
    expect(item.publishedAt).toBe("2026-07-05T08:00:00.000Z");
    expect(item.guid).toBe("tag:example.com,2026:1");
  });

  test("returns null for non-feed content", () => {
    expect(parseFeed("<html><body>not a feed</body></html>")).toBeNull();
    expect(parseFeed("")).toBeNull();
    expect(parseFeed(null)).toBeNull();
  });

  test("does not mistake an item title for the feed title", () => {
    const noChannelTitle = RSS_SAMPLE.replace("<title>Ready Set Cloud</title>", "");
    const parsed = parseFeed(noChannelTitle);
    expect(parsed.feedTitle).toBeNull();
    expect(parsed.items[0].title).toBe("Event-driven all the things");
  });
});

describe("services/rss fetchFeed", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  function mockFetchResponse({ ok = true, status = 200, contentType = "application/rss+xml", body = RSS_SAMPLE } = {}) {
    global.fetch = jest.fn().mockResolvedValue({
      ok,
      status,
      headers: { get: (h) => (h.toLowerCase() === "content-type" ? contentType : null) },
      text: async () => body,
    });
  }

  test("rejects non-public URLs before making a request (SSRF guard)", async () => {
    global.fetch = jest.fn();
    await expect(fetchFeed("http://169.254.169.254/latest/meta-data")).rejects.toThrow(/non-public/i);
    await expect(fetchFeed("http://localhost:8080/feed")).rejects.toThrow(/non-public/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("fetches and parses a public feed", async () => {
    mockFetchResponse();
    const parsed = await fetchFeed("https://www.readysetcloud.io/rss.xml");
    expect(parsed.feedTitle).toBe("Ready Set Cloud");
    expect(parsed.items).toHaveLength(2);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test("throws on non-OK status", async () => {
    mockFetchResponse({ ok: false, status: 404 });
    await expect(fetchFeed("https://example.com/feed")).rejects.toThrow(/404/);
  });

  test("throws when the body isn't a feed", async () => {
    mockFetchResponse({ body: "<html><body>login page</body></html>", contentType: "text/html" });
    await expect(fetchFeed("https://example.com/feed")).rejects.toThrow(/RSS or Atom/i);
  });

  test("throws on obviously wrong content-type", async () => {
    mockFetchResponse({ contentType: "image/png" });
    await expect(fetchFeed("https://example.com/feed")).rejects.toThrow(/content-type/i);
  });
});

describe("services/rss aggregateFeeds", () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  test("merges sources, isolates failures, dedupes, and sorts newest-first", async () => {
    // Feed A: the two RSS items. Feed B: an Atom entry. Feed C: fails.
    global.fetch = jest.fn((url) => {
      if (url.includes("feedA")) {
        return Promise.resolve({
          ok: true, status: 200,
          headers: { get: () => "application/rss+xml" },
          text: async () => RSS_SAMPLE,
        });
      }
      if (url.includes("feedB")) {
        return Promise.resolve({
          ok: true, status: 200,
          headers: { get: () => "application/atom+xml" },
          text: async () => ATOM_SAMPLE,
        });
      }
      return Promise.reject(new Error("connection refused"));
    });

    const { items, results } = await aggregateFeeds([
      { feedId: "A", url: "https://a.example.com/feedA" },
      { feedId: "B", url: "https://b.example.com/feedB" },
      { feedId: "C", url: "https://c.example.com/feedC" },
    ]);

    // 2 (A) + 1 (B) items; C contributes none.
    expect(items).toHaveLength(3);
    // Newest first: SFN (07-07) > event-driven (07-06) > atom (07-05).
    expect(items[0].title).toBe("Step Functions patterns");
    expect(items[items.length - 1].title).toBe("Serverless in 2026");
    // Items are tagged with their source.
    expect(items[0].feedId).toBe("A");

    const byId = Object.fromEntries(results.map((r) => [r.feedId, r]));
    expect(byId.A.ok).toBe(true);
    expect(byId.A.itemCount).toBe(2);
    expect(byId.C.ok).toBe(false);
    expect(byId.C.error).toMatch(/connection refused/);
  });

  test("dedupes the same story appearing in two feeds", async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true, status: 200,
        headers: { get: () => "application/rss+xml" },
        text: async () => RSS_SAMPLE,
      }),
    );

    const { items } = await aggregateFeeds([
      { feedId: "A", url: "https://a.example.com/feed" },
      { feedId: "B", url: "https://b.example.com/feed" },
    ]);

    // Both feeds return the same two items (same guids) -> deduped to 2.
    expect(items).toHaveLength(2);
  });

  test("respects the limit", async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true, status: 200,
        headers: { get: () => "application/rss+xml" },
        text: async () => RSS_SAMPLE,
      }),
    );
    const { items } = await aggregateFeeds([{ feedId: "A", url: "https://a.example.com/feed" }], { limit: 1 });
    expect(items).toHaveLength(1);
  });
});
