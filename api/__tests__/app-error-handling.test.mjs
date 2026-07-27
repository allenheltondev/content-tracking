import { jest } from "@jest/globals";

// app.mjs pulls in the whole route tree, and services/params.mjs refuses to
// load without a deployment environment.
process.env.ENVIRONMENT = "test";
process.env.TABLE_NAME = "test-booked";

const { app } = await import("../app.mjs");
const { ddb } = await import("../services/ddb.mjs");
const { createHttpRouterHandler } = await import("../services/http-handler.mjs");

const handler = createHttpRouterHandler({ app, handlerName: "test" });
const send = jest.spyOn(ddb, "send");

// A complete API Gateway proxy (V1) event carrying the authorizer context the
// real Lambda authorizer populates (an API key, which the publisher-scoped
// routes accept).
function apiGatewayEvent({ httpMethod = "GET", path }) {
  return {
    httpMethod,
    path,
    resource: "/{proxy+}",
    headers: { Host: "example.com" },
    multiValueHeaders: {},
    requestContext: {
      domainName: "example.com",
      requestId: "req-1",
      authorizer: { sub: "tenant-1", authSource: "apikey" },
      httpMethod,
      path,
    },
    isBase64Encoded: false,
    body: null,
    pathParameters: { proxy: path.slice(1) },
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
  };
}

// The Powertools Router's built-in 500, returned whenever an error handler
// itself throws. Distinct from this service's own 500 body, which is
// {"message":"Internal server error"} and always comes with a logged stack.
const ROUTER_DEFAULT_500 = "Internal Server Error";

describe("app error handling", () => {
  beforeEach(() => {
    send.mockReset();
  });

  // Regression: the notFound handler took the ({ event }) shape of a route
  // handler, but Powertools calls it as (error, requestContext). The
  // resulting TypeError was swallowed into the Router's default 500, so
  // every unmatched path returned an opaque "Internal Server Error" with no
  // log line — and clients that branch on 404 saw a fatal instead.
  test("an unmatched path returns 404, not the Router's default 500", async () => {
    const res = await handler(apiGatewayEvent({ path: "/no/such/route" }), {});

    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain(ROUTER_DEFAULT_500);
    expect(JSON.parse(res.body).message).toBe("No route registered for GET /no/such/route");
  });

  // A path that exists for another verb resolves to no route at all, so it
  // lands in the same handler.
  test("a known path with an unregistered method returns 404", async () => {
    const res = await handler(apiGatewayEvent({ httpMethod: "PUT", path: "/content/by-slug/some-post" }), {});

    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain(ROUTER_DEFAULT_500);
  });

  // The by-slug upsert the Hugo action drives: a slug nobody has registered
  // must come back as a clean 404 so the caller knows to create the post.
  test("GET /content/by-slug/:slug 404s end to end for an unregistered slug", async () => {
    send.mockResolvedValue({ Items: [], LastEvaluatedKey: undefined });

    const res = await handler(
      apiGatewayEvent({ path: "/content/by-slug/your-event-bus-should-know-how-to-wait" }),
      {},
    );

    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain(ROUTER_DEFAULT_500);
    expect(JSON.parse(res.body)).toEqual({
      message: "Content slug your-event-bus-should-know-how-to-wait not found",
      code: "NotFound",
    });
  });

  test("GET /content/by-slug/:slug returns the record when the slug resolves", async () => {
    send.mockResolvedValue({ Items: [{ contentId: "C1", slug: "a-post", title: "A Post", tags: [] }] });

    const res = await handler(apiGatewayEvent({ path: "/content/by-slug/a-post" }), {});

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).content_id).toBe("C1");
  });

  // Genuine failures still surface as this service's own 500 — the one the
  // error handler logs a stack for — rather than the Router's silent default.
  test("a domain failure returns this service's logged 500", async () => {
    send.mockRejectedValue(new Error("ValidationException: index not found"));

    const res = await handler(apiGatewayEvent({ path: "/content/by-slug/a-post" }), {});

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ message: "Internal server error" });
  });
});
