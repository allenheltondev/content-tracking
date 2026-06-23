import {
  validateBlogCreate,
  validateBlogUpdate,
  formatBlog,
  formatBlogSummary,
} from "../validation/blog.mjs";

describe("validation/blog", () => {
  describe("validateBlogCreate", () => {
    test("accepts a full payload and maps to camelCase", () => {
      const out = validateBlogCreate({
        title: "  Hello World  ",
        slug: "hello-world",
        content_markdown: "# hi",
        description: "a post",
        image: "https://img/x.png",
        image_attribution: "me",
        tags: ["Serverless"],
        categories: ["AWS"],
        canonical_url: "https://readysetcloud.io/blog/hello-world",
        campaign_id: "camp-123",
      });

      expect(out).toEqual({
        title: "Hello World",
        slug: "hello-world",
        contentMarkdown: "# hi",
        description: "a post",
        image: "https://img/x.png",
        imageAttribution: "me",
        tags: ["Serverless"],
        categories: ["AWS"],
        canonicalUrl: "https://readysetcloud.io/blog/hello-world",
        campaignId: "camp-123",
      });
    });

    test("requires title, slug, and content_markdown", () => {
      expect(() => validateBlogCreate({ slug: "x", content_markdown: "y" })).toThrow(/title is required/);
      expect(() => validateBlogCreate({ title: "x", content_markdown: "y" })).toThrow(/slug is required/);
      expect(() => validateBlogCreate({ title: "x", slug: "x" })).toThrow(/content_markdown is required/);
    });

    test("rejects a non-kebab slug", () => {
      expect(() => validateBlogCreate({ title: "x", slug: "Hello World", content_markdown: "y" })).toThrow(/kebab-case/);
    });

    test("rejects a non-http image url", () => {
      expect(() => validateBlogCreate({ title: "x", slug: "x", content_markdown: "y", image: "ftp://x" })).toThrow(/image must start with/);
    });

    test("rejects too many tags", () => {
      const tags = Array.from({ length: 31 }, (_v, i) => `t${i}`);
      expect(() => validateBlogCreate({ title: "x", slug: "x", content_markdown: "y", tags })).toThrow(/at most 30/);
    });

    test("rejects a bad campaign_id", () => {
      expect(() => validateBlogCreate({ title: "x", slug: "x", content_markdown: "y", campaign_id: "bad id!" })).toThrow(/campaign_id/);
    });

    test("rejects null for a clearable field on create", () => {
      expect(() => validateBlogCreate({ title: "x", slug: "x", content_markdown: "y", description: null })).toThrow(/cannot be null/);
    });
  });

  describe("validateBlogUpdate", () => {
    test("accepts a partial update", () => {
      expect(validateBlogUpdate({ title: "New" })).toEqual({ title: "New" });
    });

    test("clears a field with null", () => {
      expect(validateBlogUpdate({ description: null, image: null })).toEqual({ description: null, image: null });
    });

    test("rejects empty content_markdown", () => {
      expect(() => validateBlogUpdate({ content_markdown: "   " })).toThrow(/non-empty/);
    });

    test("returns an empty object for an empty body (route maps to 400)", () => {
      expect(validateBlogUpdate({})).toEqual({});
    });
  });

  describe("formatBlog / formatBlogSummary", () => {
    const row = {
      blogId: "B1",
      title: "Hi",
      slug: "hi",
      contentMarkdown: "# body",
      tags: ["a"],
      canonicalUrl: "https://x/blog/hi",
      links: { url: "https://x/blog/hi", dev: "https://dev.to/x" },
      createdAt: "t0",
      updatedAt: "t1",
    };

    test("formatBlog includes content_markdown and links", () => {
      const out = formatBlog(row);
      expect(out.blog_id).toBe("B1");
      expect(out.content_markdown).toBe("# body");
      expect(out.links).toEqual({ url: "https://x/blog/hi", dev: "https://dev.to/x" });
      expect(out.categories).toEqual([]);
      expect(out.campaign_id).toBeNull();
    });

    test("formatBlogSummary omits content_markdown", () => {
      const out = formatBlogSummary(row);
      expect(out).not.toHaveProperty("content_markdown");
      expect(out.blog_id).toBe("B1");
      expect(out.links.dev).toBe("https://dev.to/x");
    });
  });
});
