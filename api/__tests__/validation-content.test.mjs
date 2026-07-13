import {
  validateContentCreate,
  validateContentUpdate,
  validateContentQuestion,
  formatContent,
  formatContentSummary,
  formatContentAnswer,
  CONTENT_TYPES,
  CONTENT_SOURCES,
  CONTENT_STATUSES,
} from "../validation/content.mjs";

describe("validation/content", () => {
  describe("validateContentCreate", () => {
    test("accepts a minimal create and applies source/status defaults", () => {
      expect(validateContentCreate({
        title: "Hello",
        type: "blog",
        slug: "hello",
        content_markdown: "# hi",
      })).toEqual({
        title: "Hello",
        type: "blog",
        slug: "hello",
        contentMarkdown: "# hi",
        source: "owned",
        status: "draft",
      });
    });

    test("maps snake_case optional fields to camelCase", () => {
      const out = validateContentCreate({
        title: "Hello",
        type: "social",
        source: "sponsored",
        status: "published",
        slug: "hello",
        content_markdown: "body",
        description: "d",
        canonical_url: "https://x/y",
        tags: ["a"],
        categories: ["b"],
        campaign_id: "camp-1",
      });
      expect(out).toMatchObject({
        type: "social",
        source: "sponsored",
        status: "published",
        canonicalUrl: "https://x/y",
        campaignId: "camp-1",
        tags: ["a"],
        categories: ["b"],
      });
    });

    test("requires title, type, slug, and content_markdown", () => {
      expect(() => validateContentCreate({ type: "blog", slug: "x", content_markdown: "b" })).toThrow(/title is required/);
      expect(() => validateContentCreate({ title: "t", slug: "x", content_markdown: "b" })).toThrow(/type is required/);
      expect(() => validateContentCreate({ title: "t", type: "blog", content_markdown: "b" })).toThrow(/slug is required/);
      expect(() => validateContentCreate({ title: "t", type: "blog", slug: "x" })).toThrow(/content_markdown is required/);
    });

    test("rejects unknown type/source/status enums", () => {
      const base = { title: "t", slug: "x", content_markdown: "b" };
      expect(() => validateContentCreate({ ...base, type: "podcast" })).toThrow(/type must be one of/);
      expect(() => validateContentCreate({ ...base, type: "blog", source: "stolen" })).toThrow(/source must be one of/);
      expect(() => validateContentCreate({ ...base, type: "blog", status: "deleted" })).toThrow(/status must be one of/);
    });

    test("enforces the kebab-case slug rule", () => {
      const base = { title: "t", type: "blog", content_markdown: "b" };
      expect(validateContentCreate({ ...base, slug: "my-cool-post" }).slug).toBe("my-cool-post");
      expect(() => validateContentCreate({ ...base, slug: "Not Kebab" })).toThrow(/kebab-case/);
      expect(() => validateContentCreate({ ...base, slug: "UPPER" })).toThrow(/kebab-case/);
    });

    test("accepts and validates publish_date", () => {
      const base = { title: "t", type: "blog", slug: "x", content_markdown: "b" };
      expect(validateContentCreate({ ...base, publish_date: "2026-07-13" }).publishDate).toBe("2026-07-13");
      expect(() => validateContentCreate({ ...base, publish_date: "07/13/2026" })).toThrow(/publish_date must be/);
      expect(() => validateContentCreate({ ...base, publish_date: "2026-13-40" })).toThrow(/publish_date must be/);
    });

    test("enumerations expose the documented values", () => {
      expect(CONTENT_TYPES).toEqual(["blog", "social", "video"]);
      expect(CONTENT_SOURCES).toEqual(["owned", "sponsored"]);
      expect(CONTENT_STATUSES).toEqual(["draft", "scheduled", "published", "archived"]);
    });
  });

  describe("validateContentUpdate", () => {
    test("returns only the provided fields", () => {
      expect(validateContentUpdate({ title: "New", status: "archived" }))
        .toEqual({ title: "New", status: "archived" });
    });

    test("allows null to clear optional fields", () => {
      expect(validateContentUpdate({ description: null, campaign_id: null }))
        .toEqual({ description: null, campaignId: null });
    });

    test("rejects an invalid enum on update", () => {
      expect(() => validateContentUpdate({ type: "podcast" })).toThrow(/type must be one of/);
    });
  });

  describe("formatters map camel→snake", () => {
    const row = {
      contentId: "C1",
      type: "blog",
      source: "owned",
      title: "Hi",
      slug: "hi",
      description: "d",
      status: "draft",
      tags: ["a"],
      categories: ["b"],
      canonicalUrl: "https://x/y",
      contentMarkdown: "# body",
      campaignId: "camp-1",
      links: { url: "https://x/y" },
      createdAt: "t0",
      updatedAt: "t1",
    };

    test("formatContent emits the full snake_case shape", () => {
      expect(formatContent(row)).toEqual({
        content_id: "C1",
        type: "blog",
        source: "owned",
        title: "Hi",
        slug: "hi",
        description: "d",
        status: "draft",
        tags: ["a"],
        categories: ["b"],
        canonical_url: "https://x/y",
        content_markdown: "# body",
        campaign_id: "camp-1",
        publish_date: null,
        links: { url: "https://x/y" },
        created_at: "t0",
        updated_at: "t1",
      });
    });

    test("formatContentSummary omits content_markdown", () => {
      expect(formatContentSummary(row)).not.toHaveProperty("content_markdown");
      expect(formatContentSummary(row).content_id).toBe("C1");
    });
  });

  describe("validateContentQuestion", () => {
    test("accepts a minimal question and applies the default top_k", () => {
      expect(validateContentQuestion({ question: "  what did I write?  " }))
        .toEqual({ question: "what did I write?", topK: 8 });
    });

    test("threads top_k, content_id, and type through", () => {
      expect(validateContentQuestion({ question: "q", top_k: 3, content_id: "C9", type: "video" }))
        .toEqual({ question: "q", topK: 3, contentId: "C9", type: "video" });
    });

    test("rejects an empty question", () => {
      expect(() => validateContentQuestion({ question: "   " })).toThrow(/question must be a non-empty string/);
    });

    test("rejects an out-of-range top_k", () => {
      expect(() => validateContentQuestion({ question: "q", top_k: 0 })).toThrow(/top_k must be an integer/);
      expect(() => validateContentQuestion({ question: "q", top_k: 99 })).toThrow(/top_k must be an integer/);
    });

    test("rejects an unknown type", () => {
      expect(() => validateContentQuestion({ question: "q", type: "podcast" })).toThrow(/type must be one of/);
    });
  });

  describe("formatContentAnswer", () => {
    test("maps citations to snake_case sources", () => {
      expect(formatContentAnswer({
        answer: "You wrote about builds.",
        confidence: "high",
        citations: [{ contentId: "C1", title: "Builds", slug: "builds", type: "blog" }],
      })).toEqual({
        answer: "You wrote about builds.",
        confidence: "high",
        sources: [{ content_id: "C1", title: "Builds", slug: "builds", type: "blog" }],
      });
    });

    test("defaults missing citation fields to null and handles no citations", () => {
      expect(formatContentAnswer({ answer: "none", confidence: "low" }))
        .toEqual({ answer: "none", confidence: "low", sources: [] });
      expect(formatContentAnswer({
        answer: "a",
        confidence: "medium",
        citations: [{ contentId: "C2" }],
      }).sources).toEqual([{ content_id: "C2", title: null, slug: null, type: null }]);
    });
  });
});
