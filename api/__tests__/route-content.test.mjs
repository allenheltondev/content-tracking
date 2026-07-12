import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";

jest.unstable_mockModule("../services/idempotency.mjs", () => ({ withIdempotency: (fn) => fn }));
jest.unstable_mockModule("../domain/content.mjs", () => ({
  attachCampaign: jest.fn(),
  createContent: jest.fn(),
  deleteContent: jest.fn(),
  detachCampaign: jest.fn(),
  getContent: jest.fn(),
  listContentByTenant: jest.fn(),
  updateContent: jest.fn(),
}));
jest.unstable_mockModule("../domain/campaign.mjs", () => ({
  createCampaign: jest.fn(),
  findCampaign: jest.fn(),
}));
// RAG Q&A collaborators (POST /content/ask): embed the question, retrieve
// chunks, answer with Bedrock. Mocked so the route is exercised in isolation.
jest.unstable_mockModule("../services/embeddings.mjs", () => ({
  embedText: jest.fn(),
}));
jest.unstable_mockModule("../services/content-vectors.mjs", () => ({
  queryContentChunks: jest.fn(),
}));
jest.unstable_mockModule("../services/bedrock.mjs", () => ({
  answerContentQuestion: jest.fn(),
}));

const {
  attachCampaign, createContent, deleteContent, detachCampaign, getContent,
  listContentByTenant, updateContent,
} = await import("../domain/content.mjs");
const { createCampaign, findCampaign } = await import("../domain/campaign.mjs");
const { embedText } = await import("../services/embeddings.mjs");
const { queryContentChunks } = await import("../services/content-vectors.mjs");
const { answerContentQuestion } = await import("../services/bedrock.mjs");
const { registerContentRoutes } = await import("../routes/content.mjs");

function buildRouteTable() {
  const routes = {};
  const app = {
    get: (p, h) => { routes[`GET ${p}`] = h; },
    post: (p, h) => { routes[`POST ${p}`] = h; },
    put: (p, h) => { routes[`PUT ${p}`] = h; },
    patch: (p, h) => { routes[`PATCH ${p}`] = h; },
    delete: (p, h) => { routes[`DELETE ${p}`] = h; },
  };
  registerContentRoutes(app);
  return routes;
}
const routes = buildRouteTable();
const SUB = "user-1";

function ctx({ body, params, query } = {}) {
  return {
    event: {
      body: body === undefined ? undefined : JSON.stringify(body),
      queryStringParameters: query,
      requestContext: { authorizer: { authSource: "cognito", sub: SUB } },
    },
    params,
  };
}

beforeEach(() => jest.clearAllMocks());

describe("POST /content", () => {
  test("creates content scoped to the tenant", async () => {
    createContent.mockResolvedValue({ contentId: "C1", type: "blog", title: "Hi", slug: "hi", createdAt: "t0", updatedAt: "t0" });
    const res = await routes["POST /content"](ctx({
      body: { title: "Hi", type: "blog", slug: "hi", content_markdown: "b" },
    }));

    expect(res.statusCode).toBe(201);
    expect(createContent).toHaveBeenCalledWith(SUB, expect.objectContaining({
      title: "Hi", type: "blog", slug: "hi", contentMarkdown: "b", source: "owned", status: "draft",
    }));
    expect(JSON.parse(res.body).content_id).toBe("C1");
  });

  test("rejects an unauthenticated (non-cognito) caller", async () => {
    await expect(routes["POST /content"]({
      event: { body: JSON.stringify({ title: "Hi", type: "blog", slug: "hi", content_markdown: "b" }), requestContext: { authorizer: { authSource: "hmac" } } },
    })).rejects.toThrow(/dashboard sign-in/);
    expect(createContent).not.toHaveBeenCalled();
  });
});

describe("GET /content", () => {
  test("lists tenant content with summaries + cursor and passes filters", async () => {
    listContentByTenant.mockResolvedValue({
      items: [{ contentId: "C1", type: "blog", title: "a", slug: "a", createdAt: "t" }],
      lastEvaluatedKey: undefined,
    });
    const res = await routes["GET /content"](ctx({ query: { type: "blog", source: "owned", status: "published" } }));

    expect(listContentByTenant).toHaveBeenCalledWith(SUB, expect.objectContaining({
      type: "blog", source: "owned", status: "published",
    }));
    const body = JSON.parse(res.body);
    expect(body.content).toHaveLength(1);
    expect(body.content[0]).not.toHaveProperty("content_markdown");
    expect(body.nextStartKey).toBeNull();
  });
});

describe("GET /content/:contentId", () => {
  test("returns the full content for the tenant", async () => {
    getContent.mockResolvedValue({ contentId: "C1", type: "blog", title: "Hi", slug: "hi", contentMarkdown: "b", createdAt: "t", updatedAt: "t" });
    const res = await routes["GET /content/:contentId"](ctx({ params: { contentId: "C1" } }));
    expect(getContent).toHaveBeenCalledWith(SUB, "C1");
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).content_markdown).toBe("b");
  });
});

describe("PATCH /content/:contentId", () => {
  test("updates the validated fields scoped to the tenant", async () => {
    updateContent.mockResolvedValue({ contentId: "C1", type: "blog", title: "New", slug: "hi", createdAt: "t", updatedAt: "t2" });
    const res = await routes["PATCH /content/:contentId"](ctx({ params: { contentId: "C1" }, body: { title: "New" } }));
    expect(updateContent).toHaveBeenCalledWith(SUB, "C1", { title: "New" });
    expect(JSON.parse(res.body).title).toBe("New");
  });

  test("rejects an empty update body", async () => {
    await expect(routes["PATCH /content/:contentId"](ctx({ params: { contentId: "C1" }, body: {} })))
      .rejects.toThrow(/at least one updatable field/);
    expect(updateContent).not.toHaveBeenCalled();
  });

  test("routes a campaign_id through attach, not the generic update", async () => {
    attachCampaign.mockResolvedValue({ contentId: "C1", campaignId: "CMP1", title: "Hi", slug: "hi", createdAt: "t", updatedAt: "t2" });
    const res = await routes["PATCH /content/:contentId"](ctx({ params: { contentId: "C1" }, body: { campaign_id: "CMP1" } }));
    expect(attachCampaign).toHaveBeenCalledWith(SUB, "C1", "CMP1");
    expect(updateContent).not.toHaveBeenCalled();
    expect(JSON.parse(res.body).campaign_id).toBe("CMP1");
  });

  test("routes a null campaign_id through detach", async () => {
    detachCampaign.mockResolvedValue({ contentId: "C1", title: "Hi", slug: "hi", createdAt: "t", updatedAt: "t2" });
    const res = await routes["PATCH /content/:contentId"](ctx({ params: { contentId: "C1" }, body: { campaign_id: null } }));
    expect(detachCampaign).toHaveBeenCalledWith(SUB, "C1");
    expect(JSON.parse(res.body).campaign_id).toBeNull();
  });
});

describe("content sponsorship routes", () => {
  test("GET returns the attached campaign", async () => {
    getContent.mockResolvedValue({ contentId: "C1", campaignId: "CMP1" });
    findCampaign.mockResolvedValue({ campaignId: "CMP1", name: "Sponsor push", status: "active", contentId: "C1", createdAt: "t" });
    const res = await routes["GET /content/:contentId/campaign"](ctx({ params: { contentId: "C1" } }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.campaign_id).toBe("CMP1");
    expect(body.content_id).toBe("C1");
  });

  test("GET 404s for an unsponsored piece", async () => {
    getContent.mockResolvedValue({ contentId: "C1" });
    await expect(routes["GET /content/:contentId/campaign"](ctx({ params: { contentId: "C1" } })))
      .rejects.toThrow(/not found/);
    expect(findCampaign).not.toHaveBeenCalled();
  });

  test("PUT attaches an existing campaign", async () => {
    attachCampaign.mockResolvedValue({ contentId: "C1", campaignId: "CMP1", title: "Hi", slug: "hi", createdAt: "t", updatedAt: "t2" });
    const res = await routes["PUT /content/:contentId/campaign"](ctx({ params: { contentId: "C1" }, body: { campaign_id: "CMP1" } }));
    expect(attachCampaign).toHaveBeenCalledWith(SUB, "C1", "CMP1");
    expect(JSON.parse(res.body).campaign_id).toBe("CMP1");
  });

  test("PUT rejects a malformed campaign_id", async () => {
    await expect(routes["PUT /content/:contentId/campaign"](ctx({ params: { contentId: "C1" }, body: { campaign_id: "bad id!" } })))
      .rejects.toThrow(/campaign_id must be/);
    expect(attachCampaign).not.toHaveBeenCalled();
  });

  test("POST creates a campaign and attaches it", async () => {
    getContent.mockResolvedValue({ contentId: "C1" });
    createCampaign.mockResolvedValue({ campaignId: "CMP9", name: "New", status: "active", createdAt: "t" });
    attachCampaign.mockResolvedValue({ contentId: "C1", campaignId: "CMP9" });
    const res = await routes["POST /content/:contentId/campaign"](ctx({ params: { contentId: "C1" }, body: { name: "New" } }));
    expect(res.statusCode).toBe(201);
    expect(createCampaign).toHaveBeenCalledWith(expect.objectContaining({ name: "New" }));
    expect(attachCampaign).toHaveBeenCalledWith(SUB, "C1", "CMP9");
    expect(JSON.parse(res.body).content_id).toBe("C1");
  });

  test("POST refuses to create when the piece is already sponsored", async () => {
    getContent.mockResolvedValue({ contentId: "C1", campaignId: "CMP1" });
    await expect(routes["POST /content/:contentId/campaign"](ctx({ params: { contentId: "C1" }, body: { name: "New" } })))
      .rejects.toThrow(/already has a campaign/);
    expect(createCampaign).not.toHaveBeenCalled();
  });

  test("DELETE detaches the campaign and returns 204", async () => {
    detachCampaign.mockResolvedValue({ contentId: "C1" });
    const res = await routes["DELETE /content/:contentId/campaign"](ctx({ params: { contentId: "C1" } }));
    expect(res.statusCode).toBe(204);
    expect(detachCampaign).toHaveBeenCalledWith(SUB, "C1");
  });
});

describe("DELETE /content/:contentId", () => {
  test("deletes the content and returns 204", async () => {
    deleteContent.mockResolvedValue({ deleted: 1 });
    const res = await routes["DELETE /content/:contentId"](ctx({ params: { contentId: "C1" } }));
    expect(res.statusCode).toBe(204);
    expect(deleteContent).toHaveBeenCalledWith(SUB, "C1");
  });
});

describe("POST /content/ask", () => {
  const ask = () => routes["POST /content/ask"];

  test("embeds the question, retrieves chunks, and answers grounded with citations", async () => {
    embedText.mockResolvedValue([0.1, 0.2, 0.3]);
    queryContentChunks.mockResolvedValue([
      { contentId: "C1", title: "Faster Builds", slug: "faster-builds", type: "blog", text: "cut build time", distance: 0.1 },
      { contentId: "C2", title: "Caching", slug: "caching", type: "blog", text: "cache layers", distance: 0.3 },
    ]);
    answerContentQuestion.mockResolvedValue({
      answer: "You wrote about cutting build times.",
      sources_used: [1],
      confidence: "high",
    });

    const res = await ask()(ctx({ body: { question: "How do I speed up builds?" } }));

    expect(res.statusCode).toBe(200);
    expect(embedText).toHaveBeenCalledWith("How do I speed up builds?");
    // Tenant-scoped retrieval with the validated default top_k.
    expect(queryContentChunks).toHaveBeenCalledWith({
      tenantId: SUB,
      queryEmbedding: [0.1, 0.2, 0.3],
      topK: 8,
      contentId: undefined,
      type: undefined,
    });
    const body = JSON.parse(res.body);
    expect(body.answer).toMatch(/build times/);
    expect(body.confidence).toBe("high");
    // Only the cited source is surfaced.
    expect(body.sources).toEqual([{ content_id: "C1", title: "Faster Builds", slug: "faster-builds", type: "blog" }]);
  });

  test("passes top_k, content_id, and type through to retrieval", async () => {
    embedText.mockResolvedValue([0.5]);
    queryContentChunks.mockResolvedValue([{ contentId: "C9", title: "T", slug: "t", type: "video", text: "x" }]);
    answerContentQuestion.mockResolvedValue({ answer: "a", sources_used: [], confidence: "low" });

    await ask()(ctx({ body: { question: "what did I say?", top_k: 3, content_id: "C9", type: "video" } }));

    expect(queryContentChunks).toHaveBeenCalledWith({
      tenantId: SUB,
      queryEmbedding: [0.5],
      topK: 3,
      contentId: "C9",
      type: "video",
    });
  });

  test("short-circuits without calling Bedrock when nothing matches", async () => {
    embedText.mockResolvedValue([0.1]);
    queryContentChunks.mockResolvedValue([]);

    const res = await ask()(ctx({ body: { question: "obscure topic" } }));

    expect(res.statusCode).toBe(200);
    expect(answerContentQuestion).not.toHaveBeenCalled();
    const body = JSON.parse(res.body);
    expect(body.confidence).toBe("low");
    expect(body.sources).toEqual([]);
  });

  test("ignores out-of-range and duplicate source numbers from the model", async () => {
    embedText.mockResolvedValue([0.1]);
    queryContentChunks.mockResolvedValue([
      { contentId: "C1", title: "One", slug: "one", type: "blog", text: "a" },
      { contentId: "C1", title: "One", slug: "one", type: "blog", text: "b" },
    ]);
    answerContentQuestion.mockResolvedValue({ answer: "a", sources_used: [1, 2, 99], confidence: "medium" });

    const res = await ask()(ctx({ body: { question: "q" } }));
    // Both chunks are content C1, and 99 is out of range → one citation.
    expect(JSON.parse(res.body).sources).toEqual([{ content_id: "C1", title: "One", slug: "one", type: "blog" }]);
  });

  test("rejects an empty question before embedding", async () => {
    await expect(ask()(ctx({ body: { question: "   " } }))).rejects.toThrow(/question must be a non-empty string/);
    expect(embedText).not.toHaveBeenCalled();
  });
});
