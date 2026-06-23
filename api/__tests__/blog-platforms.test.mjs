import { jest } from "@jest/globals";
import { publish as publishDevto, getViews as getViewsDevto } from "../services/blog-platforms/devto.mjs";
import { publish as publishMedium, getViews as getViewsMedium } from "../services/blog-platforms/medium.mjs";
import { publish as publishHashnode, getViews as getViewsHashnode } from "../services/blog-platforms/hashnode.mjs";
import { getAdapter, adapters } from "../services/blog-platforms/index.mjs";

function mockFetch({ ok = true, status = 200, body = {} }) {
  globalThis.fetch = jest.fn(async () => ({
    ok,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  }));
}

// Returns each response in order, repeating the last (for pagination).
function mockFetchSeq(responses) {
  let i = 0;
  globalThis.fetch = jest.fn(async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return { ok: r.ok ?? true, status: r.status ?? 200, text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)) };
  });
}

function sentBody() {
  return JSON.parse(globalThis.fetch.mock.calls[0][1].body);
}

const blog = {
  title: "My Post",
  description: "Desc",
  image: "https://x/img.png",
  imageAttribution: "Me",
  canonicalUrl: "https://x/blog/my-post",
  slug: "my-post",
};

describe("blog-platforms/devto", () => {
  test("posts the article and returns id + url", async () => {
    mockFetch({ body: { id: 123, url: "https://dev.to/me/my-post-abc" } });
    const result = await publishDevto({ blog, content: "BODY", tags: ["a", "b"], config: { organizationId: "2491" }, credential: "dev-key" });

    const [url, init] = globalThis.fetch.mock.calls[0];
    expect(url).toBe("https://dev.to/api/articles");
    expect(init.headers["api-key"]).toBe("dev-key");
    expect(init.headers.accept).toBe("application/vnd.forem.api-v1+json");
    expect(sentBody().article).toMatchObject({
      title: "My Post",
      published: true,
      main_image: "https://x/img.png",
      canonical_url: "https://x/blog/my-post",
      description: "Desc",
      body_markdown: "BODY",
      organization_id: 2491,
      tags: ["a", "b"],
    });
    expect(result).toEqual({ id: 123, url: "https://dev.to/me/my-post-abc" });
  });

  test("caps tags at 4 and omits organization_id when unconfigured", async () => {
    mockFetch({ body: { id: 1, url: "u" } });
    await publishDevto({ blog, content: "B", tags: ["1", "2", "3", "4", "5", "6"], config: {}, credential: "k" });
    const article = sentBody().article;
    expect(article.tags).toEqual(["1", "2", "3", "4"]);
    expect(article).not.toHaveProperty("organization_id");
  });

  test("throws on a non-2xx response", async () => {
    mockFetch({ ok: false, status: 422, body: "Validation failed" });
    await expect(publishDevto({ blog, content: "B", tags: [], config: {}, credential: "k" })).rejects.toThrow(/Dev\.to publish failed/);
  });

  test("throws when the credential is missing", async () => {
    await expect(publishDevto({ blog, content: "B", tags: [], config: {} })).rejects.toThrow(/credential is not configured/);
  });
});

describe("blog-platforms/medium", () => {
  test("posts to the publication with the token in the query string", async () => {
    mockFetch({ body: { data: { id: "m1", url: "https://medium.com/p/abc" } } });
    const result = await publishMedium({ blog, content: "BODY", tags: ["a"], config: { publicationId: "PUB" }, credential: "secret token" });

    const [url] = globalThis.fetch.mock.calls[0];
    expect(url).toBe("https://api.medium.com/v1/publications/PUB/posts?accessToken=secret%20token");
    expect(sentBody()).toEqual({
      title: "My Post",
      contentFormat: "markdown",
      tags: ["a"],
      canonicalUrl: "https://x/blog/my-post",
      publishStatus: "draft",
      notifyFollowers: true,
      content: "BODY",
    });
    expect(result).toEqual({ id: "m1", url: "https://medium.com/p/abc" });
  });

  test("throws when publicationId is missing", async () => {
    await expect(publishMedium({ blog, content: "B", tags: [], config: {}, credential: "k" })).rejects.toThrow(/publicationId is not configured/);
  });

  test("throws on a non-2xx response", async () => {
    mockFetch({ ok: false, status: 401, body: "nope" });
    await expect(publishMedium({ blog, content: "B", tags: [], config: { publicationId: "P" }, credential: "k" })).rejects.toThrow(/Medium publish failed/);
  });
});

describe("blog-platforms/hashnode", () => {
  test("posts the GraphQL mutation and returns id/slug/url", async () => {
    mockFetch({ body: { data: { publishPost: { post: { id: "h1", slug: "my-post", url: "https://h.dev/my-post" } } } } });
    const result = await publishHashnode({
      blog,
      content: "BODY",
      tags: ["ServerlessPatterns"],
      config: { publicationId: "PUB", blogUrl: "https://h.dev" },
      credential: "hn",
    });

    const [url, init] = globalThis.fetch.mock.calls[0];
    expect(url).toBe("https://gql.hashnode.com");
    expect(init.headers.Authorization).toBe("hn");
    const input = sentBody().variables.input;
    expect(input).toMatchObject({
      title: "My Post",
      subtitle: "Desc",
      publicationId: "PUB",
      contentMarkdown: "BODY",
      originalArticleURL: "https://x/blog/my-post",
      tags: [{ slug: "ServerlessPatterns", name: "ServerlessPatterns" }],
    });
    expect(input.coverImageOptions).toEqual({ coverImageURL: "https://x/img.png", coverImageAttribution: "Me" });
    expect(result).toEqual({ id: "h1", slug: "my-post", url: "https://h.dev/my-post" });
  });

  test("composes the url from blogUrl + slug when the response omits it", async () => {
    mockFetch({ body: { data: { publishPost: { post: { id: "h1", slug: "my-post" } } } } });
    const result = await publishHashnode({ blog, content: "B", tags: [], config: { publicationId: "PUB", blogUrl: "https://h.dev/" }, credential: "hn" });
    expect(result.url).toBe("https://h.dev/my-post");
  });

  test("omits coverImageOptions when there is no image", async () => {
    mockFetch({ body: { data: { publishPost: { post: { id: "h1", slug: "s" } } } } });
    await publishHashnode({ blog: { ...blog, image: undefined }, content: "B", tags: [], config: { publicationId: "PUB" }, credential: "hn" });
    expect(sentBody().variables.input).not.toHaveProperty("coverImageOptions");
  });

  test("throws on GraphQL errors even with a 200 response", async () => {
    mockFetch({ ok: true, status: 200, body: { errors: [{ message: "publication not found" }] } });
    await expect(publishHashnode({ blog, content: "B", tags: [], config: { publicationId: "PUB" }, credential: "hn" })).rejects.toThrow(/Hashnode publish failed/);
  });
});

describe("getViews", () => {
  test("dev sums historical daily page views", async () => {
    mockFetch({ body: { "2026-01-01": { page_views: { total: 10 } }, "2026-01-02": { page_views: { total: 5 } } } });
    const views = await getViewsDevto({ id: "123", credential: "k" });
    expect(views).toBe(15);
    const [url, init] = globalThis.fetch.mock.calls[0];
    expect(url).toContain("article_id=123");
    expect(init.headers["api-key"]).toBe("k");
  });

  test("dev returns 0 with no copy id", async () => {
    expect(await getViewsDevto({ id: undefined, credential: "k" })).toBe(0);
  });

  test("medium reads totalStats via the session cookie", async () => {
    mockFetch({ body: [{ data: { post: { totalStats: { views: 99 } } } }] });
    const views = await getViewsMedium({ id: "p1", credential: "cookie-value" });
    expect(views).toBe(99);
    const [url, init] = globalThis.fetch.mock.calls[0];
    expect(url).toBe("https://medium.com/_/graphql");
    expect(init.headers.cookie).toBe("cookie-value");
    expect(JSON.parse(init.body)[0].variables.postId).toBe("p1");
  });

  test("medium surfaces a 429 as retryable (upstreamStatus 429)", async () => {
    mockFetch({ ok: false, status: 429, body: "rate limited" });
    await expect(getViewsMedium({ id: "p1", credential: "c" })).rejects.toMatchObject({ upstreamStatus: 429 });
  });

  test("hashnode finds the slug in the paginated post-stats", async () => {
    mockFetch({ body: { posts: [{ slug: "my-post", views: 42 }] } });
    const views = await getViewsHashnode({ id: "my-post", config: { publicationId: "PUB" }, credential: "hn" });
    expect(views).toBe(42);
    expect(globalThis.fetch.mock.calls[0][0]).toContain("publication=PUB");
  });

  test("hashnode returns 0 when the slug is not found", async () => {
    mockFetchSeq([{ body: { posts: [{ slug: "other", views: 1 }] } }, { body: { posts: [] } }]);
    const views = await getViewsHashnode({ id: "my-post", config: { publicationId: "PUB" }, credential: "hn" });
    expect(views).toBe(0);
  });
});

describe("blog-platforms registry", () => {
  test("maps platform names to adapters", () => {
    expect(getAdapter("dev")).toBe(adapters.dev);
    expect(getAdapter("medium")).toBe(adapters.medium);
    expect(getAdapter("hashnode")).toBe(adapters.hashnode);
    expect(typeof getAdapter("dev").publish).toBe("function");
  });

  test("throws for an unknown platform", () => {
    expect(() => getAdapter("substack")).toThrow(/No publish adapter/);
  });
});
