import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";
process.env.ENVIRONMENT = "staging";

// The Core API proxy is mocked so the route is exercised in isolation — we
// assert on what it's asked to create, not on a real HTTP call.
jest.unstable_mockModule("../services/agent-session.mjs", () => ({
  createRuntimeSession: jest.fn(),
}));

const { createRuntimeSession } = await import("../services/agent-session.mjs");
const { registerAgentRoutes } = await import("../routes/agent.mjs");

function buildRouteTable() {
  const routes = {};
  const app = {
    get: (path, handler) => { routes[`GET ${path}`] = handler; },
    post: (path, handler) => { routes[`POST ${path}`] = handler; },
    patch: (path, handler) => { routes[`PATCH ${path}`] = handler; },
    delete: (path, handler) => { routes[`DELETE ${path}`] = handler; },
    put: (path, handler) => { routes[`PUT ${path}`] = handler; },
  };
  registerAgentRoutes(app);
  return routes;
}

const routes = buildRouteTable();
const SUB = "user-1";

function ctx({ authSource = "cognito", sub = SUB, authorization = "Bearer id-token" } = {}) {
  return {
    event: {
      headers: authorization ? { Authorization: authorization } : {},
      requestContext: { authorizer: { authSource, sub } },
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  createRuntimeSession.mockResolvedValue({ sessionId: "sess-1", title: "Ask your blog" });
  delete process.env.BLOG_GROUNDING_ENABLED;
  process.env.BLOG_GATEWAY_URL = "https://abc123.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp";
});

describe("POST /agent/sessions", () => {
  test("rejects non-cognito callers (extension/apikey)", async () => {
    await expect(routes["POST /agent/sessions"](ctx({ authSource: "extension" })))
      .rejects.toThrow(/dashboard sign-in/);
    expect(createRuntimeSession).not.toHaveBeenCalled();
  });

  test("creates an ungrounded session (no mcpServers) when grounding is disabled", async () => {
    // BLOG_GROUNDING_ENABLED unset (default off) even though a gateway URL exists.
    const res = await routes["POST /agent/sessions"](ctx());

    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).sessionId).toBe("sess-1");

    const arg = createRuntimeSession.mock.calls[0][0];
    expect(arg.mcpServers).toBeUndefined();
    expect(arg.authorization).toBe("Bearer id-token");
    expect(arg.systemPrompt).toEqual(expect.stringContaining("published blog posts"));
    expect(arg.title).toBe("Ask your blog");
  });

  test("points the session at the gateway and forwards the caller's token when grounding is enabled", async () => {
    process.env.BLOG_GROUNDING_ENABLED = "true";

    await routes["POST /agent/sessions"](ctx());

    const { mcpServers } = createRuntimeSession.mock.calls[0][0];
    expect(mcpServers.blog.url).toBe("https://abc123.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp");
    expect(mcpServers.blog.transport).toBe("streamable-http");
    // The caller's Cognito token rides as the gateway Authorization header so the
    // gateway can validate it and the interceptor can read the sub.
    expect(mcpServers.blog.authHeader).toEqual({ name: "Authorization", value: "Bearer id-token" });
  });
});
