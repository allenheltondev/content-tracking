import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";
process.env.ENVIRONMENT = "staging";

// The package's event emitter is mocked so the route is exercised in isolation —
// we assert on what session it asks for, not a real EventBridge call.
jest.unstable_mockModule("@readysetcloud/agent/memory", () => ({
  requestSession: jest.fn(),
}));

const { requestSession } = await import("@readysetcloud/agent/memory");
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
  requestSession.mockResolvedValue({ sessionId: "sess-1" });
  process.env.BLOG_GATEWAY_URL = "https://abc123.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp";
});

describe("POST /agent/sessions", () => {
  test("rejects non-cognito callers (extension/apikey)", async () => {
    await expect(routes["POST /agent/sessions"](ctx({ authSource: "extension" })))
      .rejects.toThrow(/dashboard sign-in/);
    expect(requestSession).not.toHaveBeenCalled();
  });

  test("requests a grounded session pointed at the gateway, forwarding the caller's token", async () => {
    const res = await routes["POST /agent/sessions"](ctx());

    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).sessionId).toBe("sess-1");

    const arg = requestSession.mock.calls[0][0];
    expect(arg.userId).toBe(SUB);
    expect(arg.systemPrompt).toEqual(expect.stringContaining("published blog posts"));
    expect(arg.title).toBe("Ask your blog");
    expect(arg.mcpServers.blog.url).toBe("https://abc123.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp");
    expect(arg.mcpServers.blog.transport).toBe("streamable-http");
    // The caller's Cognito token rides as the gateway Authorization header so the
    // gateway can validate it and the interceptor can read the sub.
    expect(arg.mcpServers.blog.authHeader).toEqual({ name: "Authorization", value: "Bearer id-token" });
  });
});
