import { Router } from "@aws-lambda-powertools/event-handler/http";
import {
  createHttpRouterHandler,
  emptyResponse,
  jsonResponse,
} from "../services/http-handler.mjs";

// A complete API Gateway proxy (V1) event, matching the shape the
// Powertools Router's event detector requires.
function apiGatewayEvent({ httpMethod = "DELETE", path = "/things/abc" } = {}) {
  return {
    httpMethod,
    path,
    resource: "/things/{id}",
    headers: { Host: "example.com" },
    multiValueHeaders: {},
    requestContext: { domainName: "example.com", requestId: "req-1" },
    isBase64Encoded: false,
    body: null,
    pathParameters: { id: "abc" },
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
  };
}

describe("services/http-handler", () => {
  describe("emptyResponse", () => {
    // Regression: 204/205/304 are Fetch "null body" statuses. The
    // Powertools Router builds `new Response(body, { status })` from the
    // returned object, and undici throws "invalid response status code"
    // if a non-null body (even an empty string) is paired with one of
    // them. emptyResponse must omit the body for those statuses.
    test.each([204, 205, 304])("uses a null body for null-body status %i", (status) => {
      expect(emptyResponse(status).body).toBeNull();
    });

    test("keeps an empty-string body for statuses that allow one", () => {
      expect(emptyResponse(200).body).toBe("");
    });
  });

  describe("createHttpRouterHandler with a 204 route", () => {
    test("returns 204 instead of a 500 from the Response constructor", async () => {
      const app = new Router();
      app.delete("/things/:id", async () => emptyResponse(204));

      const handler = createHttpRouterHandler({ app, handlerName: "test" });
      const result = await handler(apiGatewayEvent(), {});

      expect(result.statusCode).toBe(204);
      // No error body leaked through.
      expect(result.body ?? "").not.toContain("Internal server error");
    });

    test("a 200 JSON route still works alongside the fix", async () => {
      const app = new Router();
      app.get("/things/:id", async () => jsonResponse(200, { ok: true }));

      const handler = createHttpRouterHandler({ app, handlerName: "test" });
      const result = await handler(
        apiGatewayEvent({ httpMethod: "GET" }),
        {},
      );

      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body)).toEqual({ ok: true });
    });
  });
});
