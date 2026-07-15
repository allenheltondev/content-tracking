import { jest } from "@jest/globals";

const SIGNING_KEY = "test-secret-at-least-32-characters-long!!";
process.env.BLOG_MCP_SIGNING_KEY = SIGNING_KEY;

// The RAG collaborators are mocked: it keeps the AWS SDK clients out of the unit
// test and lets us assert exactly how the tool scopes its retrieval.
jest.unstable_mockModule("../../api/services/embeddings.mjs", () => ({
  embedText: jest.fn(),
}));
jest.unstable_mockModule("../../api/services/content-vectors.mjs", () => ({
  queryContentChunks: jest.fn(),
}));

const { embedText } = await import("../../api/services/embeddings.mjs");
const { queryContentChunks } = await import("../../api/services/content-vectors.mjs");
const { signBlogGrant, BLOG_GRANT_HEADER } = await import("../../api/services/blog-mcp-grant.mjs");
const { handler } = await import("./index.mjs");

const SUB = "user-1";
const validToken = signBlogGrant({ sub: SUB, secret: SIGNING_KEY, version: 1 });

function event(body, { token = validToken, method = "POST" } = {}) {
  return {
    requestContext: { http: { method } },
    headers: token ? { [BLOG_GRANT_HEADER]: token } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function rpc(id, method, params) {
  return { jsonrpc: "2.0", id, method, params };
}

beforeEach(() => {
  jest.clearAllMocks();
  embedText.mockResolvedValue([0.1, 0.2, 0.3]);
  queryContentChunks.mockResolvedValue([]);
});

describe("transport + auth", () => {
  test("rejects non-POST with 405", async () => {
    const res = await handler(event(rpc(1, "initialize"), { method: "GET" }));
    expect(res.statusCode).toBe(405);
  });

  test("rejects a request with no grant (401)", async () => {
    const res = await handler(event(rpc(1, "tools/list"), { token: null }));
    expect(res.statusCode).toBe(401);
  });

  test("rejects a grant signed with the wrong secret (401)", async () => {
    const forged = signBlogGrant({ sub: SUB, secret: "another-secret-of-sufficient-length!!" });
    const res = await handler(event(rpc(1, "tools/list"), { token: forged }));
    expect(res.statusCode).toBe(401);
  });

  test("rejects a grant minted under a rotated-out key version (401)", async () => {
    const stale = signBlogGrant({ sub: SUB, secret: SIGNING_KEY, version: 99 });
    const res = await handler(event(rpc(1, "tools/list"), { token: stale }));
    expect(res.statusCode).toBe(401);
  });
});

describe("MCP methods", () => {
  test("initialize echoes the protocol version and advertises tools", async () => {
    const res = await handler(event(rpc(1, "initialize", { protocolVersion: "2025-06-18" })));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(body.result.capabilities.tools).toBeDefined();
    expect(body.result.serverInfo.name).toBe("booked-blog-search");
  });

  test("a notification gets a bare 202 with no body", async () => {
    const res = await handler(event(rpc(undefined, "notifications/initialized")));
    expect(res.statusCode).toBe(202);
    expect(res.body).toBe("");
  });

  test("tools/list returns the search_blog tool", async () => {
    const res = await handler(event(rpc(2, "tools/list")));
    const body = JSON.parse(res.body);
    expect(body.result.tools).toHaveLength(1);
    expect(body.result.tools[0].name).toBe("search_blog");
    expect(body.result.tools[0].inputSchema.required).toContain("query");
  });

  test("unknown method returns JSON-RPC -32601", async () => {
    const res = await handler(event(rpc(3, "resources/list")));
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe(-32601);
  });
});

describe("search_blog tool", () => {
  test("scopes retrieval to the grant's sub and type=blog, and returns cited results", async () => {
    queryContentChunks.mockResolvedValue([
      { contentId: "B1", title: "Post One", slug: "post-one", distance: 0.12, text: "alpha" },
      { contentId: "B1", title: "Post One", slug: "post-one", distance: 0.2, text: "beta" },
      { contentId: "B2", title: "Post Two", slug: "post-two", distance: 0.3, text: "gamma" },
    ]);

    const res = await handler(event(rpc(4, "tools/call", { name: "search_blog", arguments: { query: "hello", topK: 5 } })));

    expect(embedText).toHaveBeenCalledWith("hello");
    expect(queryContentChunks).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: SUB, topK: 5, type: "blog", contentId: undefined }),
    );

    const body = JSON.parse(res.body);
    expect(body.result.isError).toBe(false);
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.count).toBe(3);
    // Citations dedupe to one entry per post, in order.
    expect(payload.sources).toEqual([
      { blog_id: "B1", title: "Post One", slug: "post-one" },
      { blog_id: "B2", title: "Post Two", slug: "post-two" },
    ]);
  });

  test("clamps topK to the max and forwards an optional blogId", async () => {
    await handler(event(rpc(5, "tools/call", { name: "search_blog", arguments: { query: "x", topK: 999, blogId: "B9" } })));
    expect(queryContentChunks).toHaveBeenCalledWith(
      expect.objectContaining({ topK: 20, contentId: "B9" }),
    );
  });

  test("a missing query is a tool error, not a crash", async () => {
    const res = await handler(event(rpc(6, "tools/call", { name: "search_blog", arguments: {} })));
    const body = JSON.parse(res.body);
    expect(body.result.isError).toBe(true);
    expect(queryContentChunks).not.toHaveBeenCalled();
  });

  test("an unknown tool name is a tool error", async () => {
    const res = await handler(event(rpc(7, "tools/call", { name: "delete_everything", arguments: {} })));
    const body = JSON.parse(res.body);
    expect(body.result.isError).toBe(true);
  });
});
