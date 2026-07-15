import { jest } from "@jest/globals";

jest.unstable_mockModule("../../api/services/embeddings.mjs", () => ({
  embedText: jest.fn(),
}));
jest.unstable_mockModule("../../api/services/content-vectors.mjs", () => ({
  queryContentChunks: jest.fn(),
}));

const { embedText } = await import("../../api/services/embeddings.mjs");
const { queryContentChunks } = await import("../../api/services/content-vectors.mjs");
const { handler } = await import("./index.mjs");

const SUB = "user-1";
const ctx = { clientContext: { custom: { bedrockAgentCoreToolName: "blog___search_blog" } } };

beforeEach(() => {
  jest.clearAllMocks();
  embedText.mockResolvedValue([0.1, 0.2, 0.3]);
  queryContentChunks.mockResolvedValue([]);
});

describe("blog-search-tool", () => {
  test("scopes retrieval to the injected _callerSub and type=blog, returns cited results", async () => {
    queryContentChunks.mockResolvedValue([
      { contentId: "B1", title: "One", slug: "one", distance: 0.1, text: "alpha" },
      { contentId: "B1", title: "One", slug: "one", distance: 0.2, text: "beta" },
      { contentId: "B2", title: "Two", slug: "two", distance: 0.3, text: "gamma" },
    ]);

    const out = await handler({ query: "hello", topK: 5, _callerSub: SUB }, ctx);

    expect(embedText).toHaveBeenCalledWith("hello");
    expect(queryContentChunks).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: SUB, topK: 5, type: "blog", contentId: undefined }),
    );
    expect(out.count).toBe(3);
    expect(out.sources).toEqual([
      { blog_id: "B1", title: "One", slug: "one" },
      { blog_id: "B2", title: "Two", slug: "two" },
    ]);
  });

  test("fails closed when _callerSub is missing (interceptor not applied)", async () => {
    const out = await handler({ query: "hello" }, ctx);
    expect(out.error).toMatch(/identity is missing/i);
    expect(queryContentChunks).not.toHaveBeenCalled();
  });

  test("requires a query", async () => {
    const out = await handler({ _callerSub: SUB }, ctx);
    expect(out.error).toMatch(/query/i);
    expect(queryContentChunks).not.toHaveBeenCalled();
  });

  test("clamps topK to the max and forwards blogId", async () => {
    await handler({ query: "x", topK: 999, blogId: "B9", _callerSub: SUB }, ctx);
    expect(queryContentChunks).toHaveBeenCalledWith(
      expect.objectContaining({ topK: 20, contentId: "B9" }),
    );
  });

  test("rejects an unknown tool name from the gateway context", async () => {
    const out = await handler(
      { query: "x", _callerSub: SUB },
      { clientContext: { custom: { bedrockAgentCoreToolName: "blog___delete_everything" } } },
    );
    expect(out.error).toMatch(/unknown tool/i);
    expect(queryContentChunks).not.toHaveBeenCalled();
  });
});
