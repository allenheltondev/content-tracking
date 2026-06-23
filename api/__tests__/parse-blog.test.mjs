import { transformBlogForPlatform } from "../services/parse-blog.mjs";

const BASE = "https://readysetcloud.io";

// Two catalogued blogs: one with native copies on dev/medium, one with no
// copies yet (cross-links to it fall back to the absolute canonical).
const catalog = [
  {
    canonicalUrl: `${BASE}/blog/idempotency`,
    links: {
      url: `${BASE}/blog/idempotency`,
      dev: "https://dev.to/me/idempotency-abc",
      medium: "https://medium.com/@me/idempotency-xyz",
    },
  },
  {
    canonicalUrl: `${BASE}/blog/sqs`,
    links: { url: `${BASE}/blog/sqs` },
  },
];

function blogWith(contentMarkdown, overrides = {}) {
  return {
    title: "My Post",
    description: "A great post",
    image: `${BASE}/img/hero.png`,
    imageAttribution: "Me",
    categories: ["Serverless Patterns"],
    tags: ["AWS"],
    canonicalUrl: `${BASE}/blog/my-post`,
    contentMarkdown,
    ...overrides,
  };
}

const tweet = '{{<tweet user="allenheltondev" id="1700000000000000000">}}';
const tweetUrl = "https://twitter.com/allenheltondev/status/1700000000000000000";

describe("transformBlogForPlatform", () => {
  test("rejects an unknown platform", () => {
    expect(() => transformBlogForPlatform({ blog: blogWith(""), platform: "substack" })).toThrow(/Unknown platform/);
  });

  describe("cross-link rewriting", () => {
    test("dev: rewrites to the native dev copy", () => {
      const { body } = transformBlogForPlatform({
        blog: blogWith(`See [idempotency](${BASE}/blog/idempotency) here.`),
        catalog,
        platform: "dev",
        baseUrl: BASE,
      });
      expect(body).toBe("See [idempotency](https://dev.to/me/idempotency-abc) here.");
    });

    test("matches a relative link by path and rewrites it", () => {
      const { body } = transformBlogForPlatform({
        blog: blogWith("See [idempotency](/blog/idempotency) here."),
        catalog,
        platform: "medium",
        baseUrl: BASE,
      });
      expect(body).toContain("[idempotency](https://medium.com/@me/idempotency-xyz)");
    });

    test("falls back to the absolute canonical when no native copy exists", () => {
      const { body } = transformBlogForPlatform({
        blog: blogWith("Read [sqs](/blog/sqs)."),
        catalog,
        platform: "dev",
        baseUrl: BASE,
      });
      expect(body).toBe(`Read [sqs](${BASE}/blog/sqs).`);
    });

    test("rewrites every occurrence of a repeated target", () => {
      const { body } = transformBlogForPlatform({
        blog: blogWith(`[a](${BASE}/blog/idempotency) and [b](${BASE}/blog/idempotency)`),
        catalog,
        platform: "dev",
        baseUrl: BASE,
      });
      expect(body).toBe("[a](https://dev.to/me/idempotency-abc) and [b](https://dev.to/me/idempotency-abc)");
    });

    test("leaves non-catalogued links untouched", () => {
      const md = "External [link](https://example.com/page).";
      const { body } = transformBlogForPlatform({ blog: blogWith(md), catalog, platform: "dev", baseUrl: BASE });
      expect(body).toBe(md);
    });

    test("does NOT touch parenthetical prose (the legacy regex bug)", () => {
      const md = "It is fast (see /blog/idempotency for proof) and clean.";
      const { body } = transformBlogForPlatform({ blog: blogWith(md), catalog, platform: "dev", baseUrl: BASE });
      expect(body).toBe(md);
    });

    test("does NOT rewrite a link inside a code fence", () => {
      const md = "```\n[idempotency](/blog/idempotency)\n```";
      const { body } = transformBlogForPlatform({ blog: blogWith(md), catalog, platform: "dev", baseUrl: BASE });
      expect(body).toContain("[idempotency](/blog/idempotency)");
    });

    test("does NOT rewrite an external absolute link that only shares a path", () => {
      const md = "See [partner](https://partner.example/blog/sqs).";
      const { body } = transformBlogForPlatform({ blog: blogWith(md), catalog, platform: "dev", baseUrl: BASE });
      expect(body).toBe(md);
    });

    test("preserves a #fragment on a relative cross-link", () => {
      const { body } = transformBlogForPlatform({
        blog: blogWith("See [idem](/blog/idempotency#retry-window)."),
        catalog,
        platform: "dev",
        baseUrl: BASE,
      });
      expect(body).toBe("See [idem](https://dev.to/me/idempotency-abc#retry-window).");
    });

    test("preserves a #fragment on an absolute same-host cross-link", () => {
      const { body } = transformBlogForPlatform({
        blog: blogWith(`See [idem](${BASE}/blog/idempotency#retry-window).`),
        catalog,
        platform: "medium",
        baseUrl: BASE,
      });
      expect(body).toContain("See [idem](https://medium.com/@me/idempotency-xyz#retry-window).");
    });

    test("preserves query + fragment, including on the canonical fallback", () => {
      const { body } = transformBlogForPlatform({
        blog: blogWith("See [sqs](/blog/sqs?utm=feed#section)."),
        catalog,
        platform: "dev",
        baseUrl: BASE,
      });
      expect(body).toBe(`See [sqs](${BASE}/blog/sqs?utm=feed#section).`);
    });
  });

  describe("tweets", () => {
    test.each([
      ["dev", `{% twitter ${tweetUrl} %}`],
      ["medium", tweetUrl],
      ["hashnode", `%[${tweetUrl}]`],
    ])("%s embed", (platform, expected) => {
      const { body } = transformBlogForPlatform({ blog: blogWith(tweet), catalog, platform, baseUrl: BASE });
      expect(body).toContain(expected);
    });
  });

  describe("body composition", () => {
    test("medium prepends the header and inserts a rule before each H2", () => {
      const { body } = transformBlogForPlatform({
        blog: blogWith("Intro.\n\n## Section\n\nbody"),
        catalog,
        platform: "medium",
        baseUrl: BASE,
      });
      expect(body).toContain("# My Post");
      expect(body).toContain("#### A great post");
      expect(body).toContain(`![Me](${BASE}/img/hero.png)`);
      expect(body).toContain("\n\n---\n\n## Section");
    });

    test("medium omits description/hero lines when those fields are absent", () => {
      const { body } = transformBlogForPlatform({
        blog: blogWith("body", { description: undefined, image: undefined }),
        catalog,
        platform: "medium",
        baseUrl: BASE,
      });
      expect(body).toContain("# My Post");
      expect(body).not.toContain("####");
      expect(body).not.toContain("![");
    });

    test("dev and hashnode leave the body structure as-is (no header, no rule)", () => {
      for (const platform of ["dev", "hashnode"]) {
        const { body } = transformBlogForPlatform({
          blog: blogWith("Intro.\n\n## Section"),
          catalog,
          platform,
          baseUrl: BASE,
        });
        expect(body).toBe("Intro.\n\n## Section");
      }
    });
  });

  describe("tags", () => {
    test("dev and hashnode strip spaces; medium passes through", () => {
      const dev = transformBlogForPlatform({ blog: blogWith(""), catalog, platform: "dev", baseUrl: BASE });
      const hashnode = transformBlogForPlatform({ blog: blogWith(""), catalog, platform: "hashnode", baseUrl: BASE });
      const medium = transformBlogForPlatform({ blog: blogWith(""), catalog, platform: "medium", baseUrl: BASE });

      expect(dev.tags).toEqual(["ServerlessPatterns", "AWS"]);
      expect(hashnode.tags).toEqual(["ServerlessPatterns", "AWS"]);
      expect(medium.tags).toEqual(["Serverless Patterns", "AWS"]);
    });

    test("dedupes case-insensitively after shaping", () => {
      const { tags } = transformBlogForPlatform({
        blog: blogWith("", { categories: ["Serverless Patterns"], tags: ["serverless patterns", "AWS"] }),
        catalog,
        platform: "dev",
        baseUrl: BASE,
      });
      expect(tags).toEqual(["ServerlessPatterns", "AWS"]);
    });
  });
});
